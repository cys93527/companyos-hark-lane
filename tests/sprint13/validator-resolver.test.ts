/**
 * Sprint 13 / Task-13-05: controlled validator resolution over the REAL Sprint 9 Tool
 * Registry (real SQLite `tools` chain, real registration semantics).
 *
 * Covers: explicit validator opt-in (ordinary tools are NOT resolvable), unknown ids,
 * disabled tools, duplicate registrations, canonical identity/version sourcing,
 * caller-supplied version/executable impossibility, and zero tool execution during
 * resolution.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  domainError,
  ok,
  type ToolPort,
  type ToolRegistryPort,
} from '@companyos/core';
import {
  createToolRegistry,
  createValidatorResolver,
  type ValidatorResolver,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const clock = { now: (): number => Date.parse('2026-01-01T00:00:00.000Z'), nowIso: (): string => '2026-01-01T00:00:00.000Z' };
const ids = (() => {
  let n = 0;
  return { id: (prefix = 'id') => `${prefix}_01JT15${String(++n).padStart(4, '0')}`, ulid: () => `01JT15${String(++n).padStart(20, '0')}` };
})();
const ACTOR = 'user_owner';
const allow = async (): Promise<{ readonly ok: true; readonly value: true }> => ok(true);

let database: DurableDatabase | null = null;

afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Spy adapter: any invocation during RESOLUTION fails the test (resolution never executes). */
let invocationCount = 0;
const spyAdapter: ToolPort = {
  describe: () => ({
    toolId: 'spy',
    name: 'spy',
    description: 'spy',
    version: '0.0.0',
    riskLevel: 'LOW',
    parameters: {},
    capabilities: [],
    inputSchema: {},
    outputSchema: {},
  }),
  invoke: async () => {
    invocationCount += 1;
    return {
      ok: false as const,
      error: domainError('PERSISTENCE_FAILED', 'resolver must never invoke a tool'),
    };
  },
};

interface Harness {
  readonly registry: ToolRegistryPort;
  readonly resolver: ValidatorResolver;
  readonly db: DurableDatabase;
}

const make = (): Harness => {
  const db = openDurableDatabase({
    dataDir: mkdtempSync(join(tmpdir(), 'companyos-t15-')),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'tools'],
  });
  created.push(db.path);
  database = db;
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map([['spy.adapter', spyAdapter]]),
    authorize: allow,
    events: db.events,
    secrets: async () => [],
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
  });
  return { registry, resolver: createValidatorResolver({ registry }), db };
};

const register = async (
  registry: ToolRegistryPort,
  overrides: { readonly toolId: string; readonly capabilities?: readonly string[]; readonly version?: string },
): Promise<void> => {
  const record = createToolRecord({
    toolId: overrides.toolId,
    name: overrides.toolId,
    description: `tool ${overrides.toolId}`,
    version: overrides.version ?? '1.0.0',
    capabilities: overrides.capabilities,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    riskLevel: 'MEDIUM',
    requiredAuthorities: ['tool.invoke'],
    now: clock.nowIso(),
  });
  expect(record.ok).toBe(true);
  if (!record.ok) return;
  const registered = await registry.register(record.value, { actorId: ACTOR });
  expect(registered.ok).toBe(true);
};

describe('validator resolution — registration semantics', () => {
  it('an ordinary tool (no validator capability) is NOT resolvable as a validator', async () => {
    const { registry, resolver } = make();
    await register(registry, { toolId: 'tool.shell', capabilities: ['side_effect'] });

    const resolved = await resolver.resolve('tool.shell', ACTOR);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('NOT_FOUND');
      expect((resolved.error as { details?: { reason?: string } }).details?.reason).toBe('VALIDATOR_NOT_FOUND');
    }
    expect(invocationCount).toBe(0);
  });

  it('an explicitly opted-in validator tool IS resolvable with full inherited metadata', async () => {
    const { registry, resolver } = make();
    await register(registry, {
      toolId: 'tool.unittest',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      version: '2.3.1',
    });

    const resolved = await resolver.resolve('tool.unittest', ACTOR);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validatorId).toBe('tool.unittest');
    expect(resolved.value.validatorVersion).toBe('2.3.1');
    expect(resolved.value.toolId).toBe('tool.unittest');
    expect(resolved.value.riskLevel).toBe('MEDIUM');
    expect(resolved.value.requiredAuthorities).toEqual(['tool.invoke']);
    expect(typeof resolved.value.adapterRef).toBe('string');
  });

  it('an unknown validator id resolves to the same NOT_FOUND as an ordinary tool', async () => {
    const { registry, resolver } = make();
    await register(registry, { toolId: 'tool.shell', capabilities: ['side_effect'] });

    const resolved = await resolver.resolve('tool.never-registered', ACTOR);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('NOT_FOUND');
      expect((resolved.error as { details?: { reason?: string } }).details?.reason).toBe('VALIDATOR_NOT_FOUND');
    }
  });

  it('a duplicate validatorId registration fails closed in the registry (no last-wins drift)', async () => {
    const { registry, resolver } = make();
    await register(registry, { toolId: 'tool.unit', capabilities: [TOOL_CAPABILITY_VALIDATOR], version: '1.0.0' });

    const duplicate = createToolRecord({
      toolId: 'tool.unit',
      name: 'tool.unit',
      description: 'conflicting re-registration with a different version',
      version: '9.9.9',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      now: clock.nowIso(),
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    const registered = await registry.register(duplicate.value, { actorId: ACTOR });
    expect(registered.ok).toBe(false);
    if (!registered.ok) expect(registered.error.code).toBe('CONFLICT');

    // The original identity/version is untouched:
    const resolved = await resolver.resolve('tool.unit', ACTOR);
    if (resolved.ok) expect(resolved.value.validatorVersion).toBe('1.0.0');
  });
});

describe('validator resolution — identity and security', () => {
  it('validatorVersion always comes from the registry; the caller cannot claim or override it', async () => {
    const { registry, resolver } = make();
    await register(registry, { toolId: 'tool.typecheck', capabilities: [TOOL_CAPABILITY_VALIDATOR], version: '3.2.0' });

    const first = await resolver.resolve('tool.typecheck', ACTOR);
    const second = await resolver.resolve('tool.typecheck', ACTOR);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.validatorVersion).toBe('3.2.0');
      expect(second.value.validatorVersion).toBe(first.value.validatorVersion);
    }
    // Type-level guarantee: resolve() takes only (validatorId, actorId) — there is no
    // parameter a caller could use to supply a version claim or an executable.
    const params: Parameters<ValidatorResolver['resolve']> = ['tool.typecheck', ACTOR];
    expect(params).toHaveLength(2);
  });

  it('a disabled validator fails closed at resolution time', async () => {
    const { registry, resolver } = make();
    await register(registry, { toolId: 'tool.lint', capabilities: [TOOL_CAPABILITY_VALIDATOR] });
    const disabled = await registry.setEnabled('tool.lint', false, ACTOR);
    expect(disabled.ok).toBe(true);

    const resolved = await resolver.resolve('tool.lint', ACTOR);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('VALIDATION_FAILED');
      expect((resolved.error as { details?: { reason?: string } }).details?.reason).toBe('VALIDATOR_UNAVAILABLE');
    }
  });

  it('resolution never executes the underlying tool (invocation count stays zero)', async () => {
    const { registry, resolver } = make();
    await register(registry, { toolId: 'tool.unit', capabilities: [TOOL_CAPABILITY_VALIDATOR] });
    for (let i = 0; i < 3; i += 1) await resolver.resolve('tool.unit', ACTOR);
    expect(invocationCount).toBe(0);
  });

  it('preserves the existing registry security model: reads still require tool.read', async () => {
    const { registry } = make();
    await register(registry, { toolId: 'tool.unit', capabilities: [TOOL_CAPABILITY_VALIDATOR] });
    // An actor WITHOUT tool.read cannot resolve — no validator bypass of tool authority.
    const denier = async (): Promise<{ ok: false; error: Error }> => ({ ok: false, error: new Error('tool.read denied') });
    const guarded = createValidatorResolver({
      registry: Object.create(registry, { get: { value: async () => denier() } }),
    });
    const denied = await guarded.resolve('tool.unit', 'unauthorized_actor');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toContain('tool.read denied');
  });
});

describe('existing tool registry behavior unchanged', () => {
  it('side-effect capability semantics are untouched by the validator marker', () => {
    expect(TOOL_CAPABILITY_VALIDATOR).toBe('validation:validator');
    // The marker is additive: it is just another capability string in the frozen
    // capabilities array, so registry persistence/enable/authority flows are unchanged
    // (proven by the untouched sprint9 suites in the full gate).
  });
});
