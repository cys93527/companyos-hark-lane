/**
 * Sprint 7.5 tests A–R: Model Selection Policy (rules, not routing), benchmark metadata,
 * and the structural guarantees that keep the two apart.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  PERFORMANCE_METADATA_PURPOSE,
  SequenceIdFactory,
  evaluateManualSelection,
  precedenceLevelOf,
  type BenchmarkResult,
} from '@companyos/core';
import {
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  createSelectionPolicyService,
  type ModelRegistryService,
  type ProviderRegistry,
  type SelectionPolicyService,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2026-11-01T00:00:00.000Z');

const MODEL = (modelId: string, overrides: Record<string, unknown> = {}) => ({
  modelId,
  displayName: modelId,
  contextWindow: 1000,
  maxOutputTokens: 100,
  capabilities: { streaming: true, structuredOutput: true },
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
  ...overrides,
});

interface Fixture {
  database(): DurableDatabase;
  providers(): ProviderRegistry;
  models(): ModelRegistryService;
  policies(): SelectionPolicyService;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-selection-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'provider', 'registry', 'selection'],
    });

  let database = open();

  const build = (db: DurableDatabase) => {
    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      authorize: async () => ({ ok: true, value: true }),
      events: db.events,
      systemActor: 'user_owner',
    });
    const models = createModelRegistry({
      ids,
      clock,
      records: db.modelRecords,
      aliases: db.modelAliases,
      providers,
      events: db.events,
      scope: 'default',
    });
    const policies = createSelectionPolicyService({
      ids,
      clock,
      policies: db.selectionPolicies,
      results: db.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      events: db.events,
    });
    return { providers, models, policies };
  };

  let built = build(database);

  return {
    database: () => database,
    providers: () => built.providers,
    models: () => built.models,
    policies: () => built.policies,
    restart(): void {
      database.close();
      database = open();
      built = build(database);
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows may still hold -wal/-shm briefly; a leftover temp dir is harmless.
      }
    },
  };
};

const fixtures: Fixture[] = [];
const fixture = (): Fixture => {
  const created = make();
  fixtures.push(created);
  return created;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

/** Two providers, three models with different capabilities. */
const seedModels = async (f: Fixture): Promise<void> => {
  await f.providers().register(
    createMockProvider({
      providerId: 'mock-a',
      kind: 'mock',
      displayName: 'A',
      script: { models: [MODEL('standard'), MODEL('vision', { capabilities: { streaming: true, vision: true } })] },
    }),
  );
  await f.providers().register(
    createMockProvider({ providerId: 'mock-b', kind: 'mock', displayName: 'B', script: { models: [MODEL('cheap')] } }),
  );
  for (const [providerId, modelId] of [
    ['mock-a', 'standard'],
    ['mock-a', 'vision'],
    ['mock-b', 'cheap'],
  ] as const) {
    await f.models().registerFromProvider({ providerId, providerModelId: modelId, actorId: 'user_owner' });
  }
};

const expectErr = (result: { ok: boolean; error?: { code: string } }): string => {
  expect(result.ok).toBe(false);
  return result.error?.code ?? 'missing';
};

describe('A/O. MANUAL policies: save, read, resolve, survive restart', () => {
  it('A: saves a MANUAL policy and reads it back', async () => {
    const f = fixture();
    await seedModels(f);
    const saved = await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'developer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      allowFallback: 'NEVER',
      actorId: 'user_owner',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value).toMatchObject({
      id: 'ROLE:developer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      allowFallback: 'NEVER',
    });

    const read = await f.policies().getPolicy('ROLE', 'developer');
    expect(read?.manualModelKey).toBe('mock-a.standard');
    const resolved = await f.policies().resolveFor([{ scopeType: 'ROLE', scopeId: 'developer' }]);
    expect(resolved?.id).toBe('ROLE:developer');
  });

  it('O: keeps policies across a restart', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'WORKFLOW',
      scopeId: 'wfl_1',
      mode: 'HYBRID',
      allowedProviders: ['mock-a'],
      preferredModels: ['mock-a.vision'],
      allowFallback: 'AUTO_WITHIN_POLICY',
      actorId: 'user_owner',
    });
    f.restart();
    const policy = await f.policies().getPolicy('WORKFLOW', 'wfl_1');
    expect(policy).toMatchObject({ mode: 'HYBRID', allowedProviders: ['mock-a'], allowFallback: 'AUTO_WITHIN_POLICY' });
  });

  it('M: AUTO is stored and explained, never executed', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'AUTO',
      allowedProviders: ['mock-a'],
      actorId: 'user_owner',
    });
    const view = await f.policies().autoView([{ scopeType: 'COMPANY', scopeId: '*' }]);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.statement).toContain('Router will decide within policy');
    expect(view.value.statement).toContain('never executed');
    expect(view.value.candidateSet.modelKeys).toEqual(['mock-a.standard', 'mock-a.vision']);
    // The service exposes no chooser at all.
    expect(Object.keys(f.policies())).not.toContain('choose');
  });
});

describe('B/C/D. MANUAL refusals are explicit', () => {
  it('B: refuses a disabled model', async () => {
    const f = fixture();
    await seedModels(f);
    await f.models().setEnabled('mock-a.standard', false, 'user_owner');
    const verdict = await f.policies().explainManual({
      modelKey: 'mock-a.standard',
      scopes: [],
      explicit: true,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.accepted).toBe(false);
    expect(verdict.value.refusals).toContain('MODEL_DISABLED');
  });

  it('C: refuses an unavailable model (provider gone)', async () => {
    const f = fixture();
    await seedModels(f);
    await f.providers().unregister('mock-b');
    const verdict = await f.policies().explainManual({ modelKey: 'mock-b.cheap', scopes: [], explicit: true });
    if (!verdict.ok) throw new Error('unexpected');
    expect(verdict.value.accepted).toBe(false);
    expect(verdict.value.refusals).toContain('MODEL_UNAVAILABLE');
  });

  it('D: refuses when a required capability is missing', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'reviewer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      requiredCapabilities: ['vision'],
      actorId: 'user_owner',
    });
    const verdict = await f.policies().explainManual({
      modelKey: 'mock-a.standard',
      scopes: [{ scopeType: 'ROLE', scopeId: 'reviewer' }],
    });
    if (!verdict.ok) throw new Error('unexpected');
    expect(verdict.value.refusals).toContain('CAPABILITY_MISSING');
    // The capable model is admissible under the same policy when merely explained.
    const capable = await f.policies().explainManual({
      modelKey: 'mock-a.vision',
      scopes: [{ scopeType: 'ROLE', scopeId: 'reviewer' }],
    });
    if (!capable.ok) throw new Error('unexpected');
    expect(capable.value.accepted).toBe(true);
  });

  it('refuses an unregistered model key', async () => {
    const f = fixture();
    await seedModels(f);
    const verdict = await f.policies().explainManual({ modelKey: 'nope', scopes: [], explicit: true });
    if (!verdict.ok) throw new Error('unexpected');
    expect(verdict.value.refusals).toEqual(['MODEL_NOT_REGISTERED']);
  });
});

describe('E/F/G/H. precedence is frozen', () => {
  it('E: an explicit user choice beats the role policy range (but never a hard block)', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'developer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      allowedModels: ['mock-a.standard'],
      actorId: 'user_owner',
    });
    const scopes = [{ scopeType: 'ROLE' as const, scopeId: 'developer' }];

    // Without an explicit choice, a model outside the role's allowed set is refused.
    const outside = await f.policies().explainManual({ modelKey: 'mock-b.cheap', scopes });
    if (!outside.ok) throw new Error('unexpected');
    expect(outside.value.accepted).toBe(false);
    expect(outside.value.refusals).toContain('MODEL_BLOCKED_BY_POLICY');

    // The user explicitly picks it: the role's range no longer applies (highest rung).
    const explicit = await f.policies().explainManual({ modelKey: 'mock-b.cheap', scopes, explicit: true });
    if (!explicit.ok) throw new Error('unexpected');
    expect(explicit.value.accepted).toBe(true);
    expect(explicit.value.precedence).toBe('EXPLICIT_USER_CHOICE');

    // A hard block is an absolute rule, not a range: it still refuses.
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'developer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      blockedModels: ['mock-b.cheap'],
      actorId: 'user_owner',
    });
    const hardBlocked = await f.policies().explainManual({ modelKey: 'mock-b.cheap', scopes, explicit: true });
    if (!hardBlocked.ok) throw new Error('unexpected');
    expect(hardBlocked.value.accepted).toBe(false);
    expect(hardBlocked.value.refusals).toContain('MODEL_BLOCKED_BY_POLICY');
  });

  it('F: a task override beats the role policy', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'developer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      actorId: 'user_owner',
    });
    await f.policies().savePolicy({
      scopeType: 'TASK',
      scopeId: 'tsk_42',
      mode: 'MANUAL',
      manualModelKey: 'mock-b.cheap',
      actorId: 'user_owner',
    });
    const resolved = await f.policies().resolveFor([
      { scopeType: 'ROLE', scopeId: 'developer' },
      { scopeType: 'TASK', scopeId: 'tsk_42' },
    ]);
    expect(resolved?.id).toBe('TASK:tsk_42');
    const verdict = await f.policies().explainManual({
      modelKey: 'mock-b.cheap',
      scopes: [
        { scopeType: 'ROLE', scopeId: 'developer' },
        { scopeType: 'TASK', scopeId: 'tsk_42' },
      ],
      taskOverride: true,
    });
    if (!verdict.ok) throw new Error('unexpected');
    expect(verdict.value.precedence).toBe('TASK_OVERRIDE');
  });

  it('G/H: role beats workflow, workflow beats company', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({ scopeType: 'COMPANY', scopeId: '*', mode: 'HYBRID', actorId: 'user_owner' });
    await f.policies().savePolicy({ scopeType: 'WORKFLOW', scopeId: 'wfl_1', mode: 'HYBRID', actorId: 'user_owner' });
    await f.policies().savePolicy({ scopeType: 'ROLE', scopeId: 'developer', mode: 'HYBRID', actorId: 'user_owner' });

    const roleWins = await f.policies().resolveFor([
      { scopeType: 'WORKFLOW', scopeId: 'wfl_1' },
      { scopeType: 'ROLE', scopeId: 'developer' },
    ]);
    expect(roleWins?.id).toBe('ROLE:developer');

    const workflowWins = await f.policies().resolveFor([
      { scopeType: 'COMPANY', scopeId: '*' },
      { scopeType: 'WORKFLOW', scopeId: 'wfl_1' },
    ]);
    expect(workflowWins?.id).toBe('WORKFLOW:wfl_1');

    const companyOnly = await f.policies().resolveFor([{ scopeType: 'COMPANY', scopeId: '*' }]);
    expect(companyOnly?.id).toBe('COMPANY:*');
  });
});

describe('I/J/K/L/N. policy scope and fallback semantics', () => {
  it('I: blockedModels refuses, J: allowedProviders refuses another provider', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'HYBRID',
      blockedModels: ['mock-a.standard'],
      allowedProviders: ['mock-b'],
      actorId: 'user_owner',
    });
    const scopes = [{ scopeType: 'COMPANY' as const, scopeId: '*' }];

    const blocked = await f.policies().explainManual({ modelKey: 'mock-a.standard', scopes, explicit: true });
    if (!blocked.ok) throw new Error('unexpected');
    expect(blocked.value.refusals).toContain('MODEL_BLOCKED_BY_POLICY');

    const wrongProvider = await f.policies().explainManual({ modelKey: 'mock-b.cheap', scopes, explicit: true });
    if (!wrongProvider.ok) throw new Error('unexpected');
    expect(wrongProvider.value.accepted).toBe(true);

    const otherProvider = await f.policies().explainManual({ modelKey: 'mock-a.vision', scopes, explicit: true });
    if (!otherProvider.ok) throw new Error('unexpected');
    expect(otherProvider.value.refusals).toContain('PROVIDER_NOT_ALLOWED');
  });

  it('K: NEVER never offers a fallback; L: ASK defers to the human', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'developer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      allowFallback: 'NEVER',
      actorId: 'user_owner',
    });
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: 'reviewer',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.vision',
      allowFallback: 'ASK',
      actorId: 'user_owner',
    });

    const never = await f.policies().explainManual({
      modelKey: 'mock-a.standard',
      scopes: [{ scopeType: 'ROLE', scopeId: 'developer' }],
      explicit: true,
    });
    if (!never.ok) throw new Error('unexpected');
    expect(never.value.fallback).toBe('NEVER');
    expect(never.value.allowedFallbackModelKeys).toEqual([]);

    const ask = await f.policies().explainManual({
      modelKey: 'mock-a.vision',
      scopes: [{ scopeType: 'ROLE', scopeId: 'reviewer' }],
      explicit: true,
    });
    if (!ask.ok) throw new Error('unexpected');
    expect(ask.value.fallback).toBe('ASK');
    // ASK means "ask the user": the service offers no candidate set to run automatically.
    expect(ask.value.allowedFallbackModelKeys).toEqual([]);
  });

  it('K: AUTO_WITHIN_POLICY bounds the fallback set to the allowed scope', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'WORKFLOW',
      scopeId: 'wfl_1',
      mode: 'HYBRID',
      allowedProviders: ['mock-a'],
      preferredModels: ['mock-a.vision'],
      allowFallback: 'AUTO_WITHIN_POLICY',
      actorId: 'user_owner',
    });
    const verdict = await f.policies().explainManual({
      modelKey: 'mock-b.cheap',
      scopes: [{ scopeType: 'WORKFLOW', scopeId: 'wfl_1' }],
      explicit: true,
    });
    if (!verdict.ok) throw new Error('unexpected');
    // mock-b.cheap is explicitly requested but outside the allowed providers.
    expect(verdict.value.refusals).toContain('PROVIDER_NOT_ALLOWED');
    // …and the only models the caller may consider are inside the policy.
    expect(verdict.value.allowedFallbackModelKeys).toEqual(['mock-a.standard', 'mock-a.vision']);
  });

  it('N: the hybrid candidate set lists preferred first and explains exclusions', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'WORKFLOW',
      scopeId: 'wfl_1',
      mode: 'HYBRID',
      preferredModels: ['mock-b.cheap'],
      blockedModels: ['mock-a.vision'],
      requiredCapabilities: ['streaming'],
      allowedProviders: ['mock-a', 'mock-b'],
      actorId: 'user_owner',
    });
    const view = await f.policies().hybridView([{ scopeType: 'WORKFLOW', scopeId: 'wfl_1' }]);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.mode).toBe('HYBRID');
    expect(view.value.preferred).toEqual(['mock-b.cheap']);
    expect(view.value.modelKeys).toEqual(['mock-b.cheap', 'mock-a.standard']);
    expect(view.value.excluded).toContainEqual({ modelKey: 'mock-a.vision', reason: 'blocked_by_policy' });
  });
});

describe('R. benchmark metadata never drives selection', () => {
  it('records results, summarizes them, and changes no selection outcome', async () => {
    const f = fixture();
    await seedModels(f);
    const result = (modelKey: string, category: BenchmarkResult['category'], score: number): BenchmarkResult => ({
      id: `br_${modelKey}_${category}`,
      modelKey,
      suiteId: 'suite_v1',
      caseId: `case_${category}`,
      category,
      score,
      measuredValue: score,
      notes: 'harness sample',
      source: 'harness',
      recordedAt: EPOCH === 0 ? 'x' : '2026-11-01T00:00:00.000Z',
      recordedBy: 'user_owner',
    });

    const before = await f.policies().explainManual({ modelKey: 'mock-a.standard', scopes: [] });
    const recorded = await f.policies().recordBenchmarkResults(
      [result('mock-a.standard', 'CODING', 0.1), result('mock-b.cheap', 'CODING', 0.99)],
      'user_owner',
    );
    expect(recorded.ok).toBe(true);

    const metadata = await f.policies().performanceMetadata();
    expect(metadata.map((entry) => entry.modelKey)).toEqual(['mock-a.standard', 'mock-b.cheap']);
    expect(metadata.find((entry) => entry.modelKey === 'mock-b.cheap')?.byCategory.CODING).toBe(0.99);

    // The policy layer never consults the numbers: the same question gets the same answer.
    const after = await f.policies().explainManual({ modelKey: 'mock-a.standard', scopes: [] });
    expect(after).toEqual(before);
    // …and the metadata declares its own purpose.
    expect(PERFORMANCE_METADATA_PURPOSE).toBe('display-and-planning-only');
  });

  it('rejects an out-of-range or unknown-category result', async () => {
    const f = fixture();
    await seedModels(f);
    const bad = {
      id: 'br_bad',
      modelKey: 'mock-a.standard',
      suiteId: 's',
      caseId: 'c',
      category: 'TELEPATHY' as never,
      score: 2,
      measuredValue: null,
      notes: '',
      source: 'harness' as const,
      recordedAt: 'x',
      recordedBy: 'user_owner',
    };
    expect(expectErr(await f.policies().recordBenchmarkResults([bad], 'user_owner'))).toBe('VALIDATION_FAILED');
  });
});

describe('P/Q. boundaries of the selection layer', () => {
  it('P: the registry UI carries the mode UI and never touches persistence', () => {
    const raw = readFileSync(
      fileURLToPath(new URL('../../apps/renderer/src/registry.tsx', import.meta.url)),
      'utf8',
    );
    expect(raw).toMatch(/models\.policy|Selection Mode|Manual|Hybrid/i);
    expect(raw).not.toMatch(/@companyos\/persistence/);
    expect(raw).not.toMatch(/@companyos\/core/);
    expect(raw).not.toMatch(/node:sqlite/);
  });

  it('Q: no vendor name and no routing identifier in the new modules', () => {
    const vendors = ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama'];
    const files = [
      '../../packages/core/src/domain/model-selection-policy.ts',
      '../../packages/core/src/domain/benchmark.ts',
      '../../packages/engine/src/registry/selection-policy.ts',
    ];
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .toLowerCase();
      for (const vendor of vendors) {
        expect(new RegExp(`\\b${vendor}\\b`).test(code), `${file} names ${vendor}`).toBe(false);
      }
      // No scoring / ranking / auto-selection implementation.
      expect(code).not.toMatch(/\b(?:scoremodel|rankmodels|bestmodel|autoselect|executefallback)\b/);
    }
  });

  it('R: the selection policy module does not import benchmark metadata', () => {
    const policy = readFileSync(
      fileURLToPath(new URL('../../packages/core/src/domain/model-selection-policy.ts', import.meta.url)),
      'utf8',
    );
    expect(policy).not.toMatch(/from '\.\/benchmark\.js'/);
    const enginePolicy = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/registry/selection-policy.ts', import.meta.url)),
      'utf8',
    );
    // It may STORE results; the evaluate call must not receive any of them.
    const call = enginePolicy.slice(enginePolicy.indexOf('evaluateManualSelection({'));
    const statement = call.slice(0, call.indexOf('});'));
    expect(statement).not.toMatch(/metadata|performance/i);
  });
});

describe('Closeout-7.5 MEDIUM-2. the interpreter matches the frozen ladder exactly', () => {
  it('a TASK-scoped policy IS the task rung, even without an override flag', async () => {
    const f = fixture();
    await seedModels(f);
    await f.policies().savePolicy({
      scopeType: 'TASK',
      scopeId: 'tsk_9',
      mode: 'MANUAL',
      manualModelKey: 'mock-a.standard',
      actorId: 'user_owner',
    });
    const verdict = await f.policies().explainManual({
      modelKey: 'mock-a.standard',
      scopes: [{ scopeType: 'TASK', scopeId: 'tsk_9' }],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.accepted).toBe(true);
    // Previously this fell through to GLOBAL_DEFAULT.
    expect(verdict.value.precedence).toBe('TASK_OVERRIDE');
  });

  it('every ladder rung is reachable from some input', () => {
    expect(precedenceLevelOf({ explicitModelKey: 'm', taskOverride: false, resolvedScope: 'COMPANY' })).toBe(
      'EXPLICIT_USER_CHOICE',
    );
    expect(precedenceLevelOf({ explicitModelKey: null, taskOverride: true, resolvedScope: 'ROLE' })).toBe(
      'TASK_OVERRIDE',
    );
    expect(precedenceLevelOf({ explicitModelKey: null, taskOverride: false, resolvedScope: 'TASK' })).toBe(
      'TASK_OVERRIDE',
    );
    expect(precedenceLevelOf({ explicitModelKey: null, taskOverride: false, resolvedScope: 'ROLE' })).toBe(
      'ROLE_POLICY',
    );
    expect(precedenceLevelOf({ explicitModelKey: null, taskOverride: false, resolvedScope: 'WORKFLOW' })).toBe(
      'WORKFLOW_POLICY',
    );
    expect(precedenceLevelOf({ explicitModelKey: null, taskOverride: false, resolvedScope: 'COMPANY' })).toBe(
      'COMPANY_POLICY',
    );
    // Reserved for the future router: reachable only when a caller says so.
    expect(
      precedenceLevelOf({
        explicitModelKey: null,
        taskOverride: false,
        resolvedScope: null,
        routerRecommendation: true,
      }),
    ).toBe('ROUTER_RECOMMENDATION');
    expect(precedenceLevelOf({ explicitModelKey: null, taskOverride: false, resolvedScope: null })).toBe(
      'GLOBAL_DEFAULT',
    );
  });

  it('evaluateManualSelection reports the router rung without letting it win', () => {
    const verdict = evaluateManualSelection({
      modelKey: 'm',
      policy: null,
      records: [],
      routerRecommendation: true,
    });
    // It cannot be accepted (the model is unknown) - but the source is named correctly,
    // and a router recommendation never outranks a policy or a user choice.
    expect(verdict.precedence).toBe('ROUTER_RECOMMENDATION');
    expect(verdict.accepted).toBe(false);
  });
});
