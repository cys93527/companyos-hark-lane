/**
 * Sprint 1 Task 5 + STEP 7 red line:
 *   **Role must not bind a model. Agent must not bind a provider.**
 * Both Workflow and Role/Agent must stay industry-agnostic.
 *
 * Review finding HIGH-3 shaped the design: the Agent rule is a closed ALLOW-LIST of
 * logical capability slots, so Core needs to know no vendor name at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LOGICAL_BINDING_SLOTS,
  LOGICAL_BINDING_VARIANTS,
  ROLE_FORBIDDEN_BINDINGS,
  assignModelBinding,
  clearModelBinding,
  createAgent,
  createRole,
  hasAuthority,
  logicalSlotOf,
  roleIsModelAgnostic,
  setAgentStatus,
  validateModelBindingRef,
  withCapabilities,
  type CompanyId,
  type RoleId,
} from '@companyos/core';

import { expectErr, expectOk, makeIds, nowIso } from './support.js';

const companyId = 'cmp_1' as CompanyId;

const newRole = () =>
  expectOk(
    createRole({
      companyId,
      key: 'reviewer',
      name: 'Reviewer',
      description: 'independent review',
      requiredCapabilities: ['pack-a:review'],
      authority: ['run.review'],
      now: nowIso(),
      ids: makeIds(),
    }),
  );

const newAgent = (roleId: RoleId, modelBindingRef?: string) =>
  createAgent({
    companyId,
    roleId,
    displayName: 'Agent 1',
    now: nowIso(),
    ids: makeIds(),
    ...(modelBindingRef === undefined ? {} : { modelBindingRef }),
  });

describe('Role — a position, never a model binding', () => {
  it('creates a role with capabilities and authority', () => {
    const role = newRole();
    expect(role.key).toBe('reviewer');
    expect(role.requiredCapabilities).toEqual(['pack-a:review']);
    expect(hasAuthority(role, 'run.review')).toBe(true);
    expect(hasAuthority(role, 'run.approve')).toBe(false);
  });

  it('validates key and name', () => {
    const bad = (key: string) =>
      expectErr(createRole({ companyId, key, name: 'X', now: nowIso(), ids: makeIds() })).code;
    expect(bad('Reviewer')).toBe('INVALID_ARGUMENT');
    expect(bad('a')).toBe('INVALID_ARGUMENT');
    expect(bad('a'.repeat(40))).toBe('INVALID_ARGUMENT');
    expect(bad('bad key')).toBe('INVALID_ARGUMENT');
    expect(
      expectErr(createRole({ companyId, key: 'ok-key', name: '   ', now: nowIso(), ids: makeIds() })).code,
    ).toBe('INVALID_ARGUMENT');
    expect(expectOk(createRole({ companyId, key: 'ok-key', name: 'X', now: nowIso(), ids: makeIds() })).key).toBe(
      'ok-key',
    );
  });

  it('carries NO model or provider field at all', () => {
    const role = newRole();
    const asRecord = role as unknown as Record<string, unknown>;
    expect(roleIsModelAgnostic(asRecord)).toBe(true);
    expect([...ROLE_FORBIDDEN_BINDINGS]).toHaveLength(5);
    for (const forbidden of ROLE_FORBIDDEN_BINDINGS) {
      expect(Object.keys(asRecord)).not.toContain(forbidden);
    }
    // A role's capability ids are namespaced pack capabilities, never model names.
    for (const capability of role.requiredCapabilities) {
      expect(capability).toMatch(/^[a-z0-9-]+:[a-z0-9.-]+$/);
    }
  });

  it('rejects duplicate capabilities', () => {
    const role = newRole();
    expect(expectErr(withCapabilities(role, ['a:b', 'a:b'], nowIso(1))).code).toBe('INVALID_ARGUMENT');
    expect(expectOk(withCapabilities(role, ['a:b', 'c:d'], nowIso(1))).requiredCapabilities).toEqual(['a:b', 'c:d']);
  });
});

describe('Agent — a worker, never a provider binding', () => {
  it('creates an unassigned agent', () => {
    const agent = expectOk(newAgent(newRole().id));
    expect(agent.modelBindingRef).toBeNull();
    expect(agent.status).toBe('idle');
    expect(agent.id.startsWith('agt_')).toBe(true);
    for (const forbidden of ['provider', 'providerId', 'modelId', 'model']) {
      expect(Object.keys(agent as unknown as Record<string, unknown>)).not.toContain(forbidden);
    }
  });

  it('accepts a LOGICAL binding reference naming a capability slot', () => {
    const agent = expectOk(newAgent(newRole().id, 'logical.reasoning.default'));
    expect(agent.modelBindingRef).toBe('logical.reasoning.default');
    expect(logicalSlotOf('logical.reasoning.default')).toBe('reasoning');
    expect(logicalSlotOf('logical.fast')).toBe('fast');
    expect(logicalSlotOf('logical.not-a-slot')).toBeNull();
  });

  it('exposes closed vocabularies that contain no implementation name', () => {
    expect(LOGICAL_BINDING_SLOTS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(LOGICAL_BINDING_SLOTS).size).toBe(LOGICAL_BINDING_SLOTS.length);
    expect([...LOGICAL_BINDING_VARIANTS]).toEqual(['default', 'cheap', 'balanced', 'strong']);
    const vendorLike = /openai|anthropic|deepseek|gemini|kimi|qwen|gpt|claude|mistral|llama/i;
    for (const token of [...LOGICAL_BINDING_SLOTS, ...LOGICAL_BINDING_VARIANTS]) {
      expect(vendorLike.test(token), `${token} must not name a vendor or model`).toBe(false);
    }
    // No slot may be a tier and vice versa (otherwise the two segments blur).
    for (const slot of LOGICAL_BINDING_SLOTS) {
      expect(LOGICAL_BINDING_VARIANTS as readonly string[]).not.toContain(slot);
    }
  });

  it('rejects concrete provider/model bindings, unknown slots AND unknown tiers', () => {
    const roleId = newRole().id;
    for (const ref of [
      'openai:gpt-4',
      'anthropic/claude',
      'provider:deepseek',
      'model:gpt-4o',
      'logical.openai.default',
      'logical.gemini.fast',
      'logical.mistral.default',
      'logical.llama.70b',
      'deepseek-chat',
      // The tier segment must be closed too (review re-inspection): otherwise the
      // red line is bypassable through the variant.
      'logical.reasoning.gpt4',
      'logical.reasoning.mistral',
      'logical.review.claude',
      'logical.reasoning.4o-mini',
    ]) {
      const result = newAgent(roleId, ref);
      expect(result.ok, `${ref} must be refused`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('POLICY_DENIED');
    }
  });

  it('accepts slot-only and slot+tier references', () => {
    const roleId = newRole().id;
    for (const ref of [
      'logical.reasoning',
      'logical.reasoning.default',
      'logical.reasoning.strong',
      'logical.fast',
      'logical.review.cheap',
      'logical.writing.balanced',
    ]) {
      const result = newAgent(roleId, ref);
      expect(result.ok, `${ref} must be accepted`).toBe(true);
    }
  });

  it('rejects refs that are malformed rather than unknown', () => {
    expect(expectErr(validateModelBindingRef('reasoning')).code).toBe('POLICY_DENIED');
    expect(expectErr(validateModelBindingRef('logical.')).code).toBe('POLICY_DENIED');
    expect(expectErr(validateModelBindingRef('logical.Reasoning')).code).toBe('POLICY_DENIED');
  });

  it('assigns, clears and validates binding transitions', () => {
    const agent = expectOk(newAgent(newRole().id));
    const assigned = expectOk(assignModelBinding(agent, 'logical.writing.cheap', nowIso(1)));
    expect(assigned.modelBindingRef).toBe('logical.writing.cheap');
    expect(expectErr(assignModelBinding(agent, 'logical.mistral.default', nowIso(1))).code).toBe(
      'POLICY_DENIED',
    );
    expect(expectErr(assignModelBinding(agent, 'logical.writing.gpt4', nowIso(1))).code).toBe(
      'POLICY_DENIED',
    );

    const cleared = expectOk(clearModelBinding(assigned, nowIso(2)));
    expect(cleared.modelBindingRef).toBeNull();
    expect(expectErr(clearModelBinding(cleared, nowIso(3))).code).toBe('CONFLICT');
  });

  it('tracks agent status', () => {
    const agent = expectOk(newAgent(newRole().id));
    expect(expectOk(setAgentStatus(agent, 'busy', nowIso(1))).status).toBe('busy');
    expect(expectErr(setAgentStatus(agent, 'idle', nowIso(1))).code).toBe('CONFLICT');
  });
});

describe('domain files stay industry-agnostic', () => {
  it('contains no forbidden noun as an identifier in the new domain sources', () => {
    const files = [
      'agent',
      'approval',
      'artifact',
      'catalog',
      'company',
      'event',
      'pack',
      'role',
      'run-state',
      'stage',
      'task',
      'validation',
      'workflow',
      'workflow-run',
    ];
    const forbidden = ['coding', 'git', 'repository', 'developer', 'cto', 'article', 'video', 'ecommerce'];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../src/domain/${file}.ts`, import.meta.url)),
        'utf8',
      );
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .replace(/'[^'\n]*'/g, "''")
        .replace(/"[^"\n]*"/g, '""');
      for (const noun of forbidden) {
        if (new RegExp(`\\b${noun}\\b`, 'i').test(code)) offenders.push(`${file}: ${noun}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no model vendor anywhere in Core domain source', () => {
    const files = ['agent', 'catalog', 'role', 'workflow-run', 'run-state'];
    const vendorLike = /openai|anthropic|deepseek|gemini|kimi|gpt-|claude/i;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../src/domain/${file}.ts`, import.meta.url)),
        'utf8',
      );
      // Even inside comments and string literals (review finding HIGH-3): Core must
      // not need to know vendor names at all.
      if (vendorLike.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
