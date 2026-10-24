/**
 * Sprint 15 / Task-15-02: canonical PackManifest semantic model (ADR-0024) —
 * the SEMANTIC AUTHORITY. Covers the canonical field set, the nine declaration
 * categories (including the Boss-ruled minimal Generic Template contract), strict
 * validation (unknown/security-relevant fields rejected), namespace + dependency
 * rules, and the closed authority boundary.
 */
import { describe, expect, it } from 'vitest';

import {
  OPAQUE_TOKEN_PATTERN,
  isAuthority,
  isJsonValue,
  packQualifiedKey,
  parsePackQualifiedKey,
  validatePackManifest,
  type JsonValue,
} from '@companyos/core';

const canonicalFixture = () => ({
  manifestVersion: 1,
  packId: 'pack-fixture',
  packVersion: '1.0.0',
  name: 'Industry-neutral fixture pack',
  coreApi: '1',
  capabilities: [{ id: 'pack-fixture:patch.apply', description: 'apply a patch', approval: 'none' as const }],
  dependsOn: [{ packId: 'pack-other', packVersion: '2.0.0' }],
  declarations: {
    roles: [{ key: 'pack-fixture:reviewer', label: 'Reviewer', authorityRefs: ['workflow.review'] }],
    workflowTemplates: [
      {
        key: 'pack-fixture:feature',
        name: 'Feature flow',
        description: '',
        graph: {
          nodes: [{ id: 's1', kind: 'work', title: 'Work', config: { validatorIds: ['val.unit'] } }],
          edges: [],
        },
      },
    ],
    prompts: [{ key: 'pack-fixture:summary', template: 'Summarize {{x}}', version: null }],
    tools: [{ key: 'pack-fixture:fs', toolId: 'tool.filesystem', capability: null }],
    validators: [{ key: 'pack-fixture:unit', validatorId: 'tool.unittest' }],
    artifacts: [{ key: 'pack-fixture:diff', label: 'Diff', description: '' }],
    riskRules: [{ key: 'pack-fixture:high-risk', riskLevel: 'HIGH', description: '' }],
    capabilityRules: [{ key: 'pack-fixture:needs-fs', requires: ['pack-fixture:filesystem'], exposes: [] }],
    templates: [{ key: 'pack-fixture:document-template', kind: 'some-type', content: { title: 'x' } }],
  },
});

describe('canonical manifest (ADR-0024)', () => {
  it('accepts a full canonical manifest with all nine declaration categories', () => {
    const result = validatePackManifest(canonicalFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifestVersion).toBe(1);
    expect(result.value.packId).toBe('pack-fixture');
    expect(result.value.declarations.roles).toHaveLength(1);
    expect(result.value.declarations.workflowTemplates[0]?.graph.nodes[0]?.id).toBe('s1');
    expect(result.value.declarations.templates[0]).toEqual({
      key: 'pack-fixture:document-template',
      kind: 'some-type',
      content: { title: 'x' },
    });
    expect(result.value.dependsOn).toEqual([{ packId: 'pack-other', packVersion: '2.0.0' }]);
  });

  it('rejects unknown top-level and declaration-category fields (strict, never stripped)', () => {
    expect(validatePackManifest({ ...canonicalFixture(), description: 'extra' }).ok).toBe(false);
    expect(
      validatePackManifest({
        ...canonicalFixture(),
        declarations: { ...canonicalFixture().declarations, agents: [] },
      }).ok,
    ).toBe(false);
    // Security-sensitive fields are rejected even inside declarations.
    expect(
      validatePackManifest({
        ...canonicalFixture(),
        declarations: {
          ...canonicalFixture().declarations,
          roles: [{ ...canonicalFixture().declarations.roles[0], assignTo: ['user_x'] }],
        },
      }).ok,
    ).toBe(false);
    // And a role that tries to grant an unknown authority (pack.superadmin) fails closed.
    expect(
      validatePackManifest({
        ...canonicalFixture(),
        declarations: {
          ...canonicalFixture().declarations,
          roles: [{ key: 'pack-fixture:king', label: 'King', authorityRefs: ['pack.superadmin'] }],
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects invalid identity/compatibility fields', () => {
    expect(validatePackManifest({ ...canonicalFixture(), manifestVersion: 2 }).ok).toBe(false);
    expect(validatePackManifest({ ...canonicalFixture(), coreApi: '99' }).ok).toBe(false);
    expect(validatePackManifest({ ...canonicalFixture(), packId: 'Bad Id' }).ok).toBe(false);
    expect(validatePackManifest({ ...canonicalFixture(), packVersion: 'v1' }).ok).toBe(false);
  });
});

describe('dependency contract (ADR-0026)', () => {
  it('accepts exact-version dependencies', () => {
    const result = validatePackManifest({ ...canonicalFixture(), dependsOn: [{ packId: 'pack-a', packVersion: '1.2.3' }] });
    expect(result.ok).toBe(true);
  });

  it('rejects ranges, self-dependencies and duplicate dependencies', () => {
    expect(validatePackManifest({ ...canonicalFixture(), dependsOn: [{ packId: 'pack-a', packVersion: '^1.2' }] }).ok).toBe(false);
    expect(validatePackManifest({ ...canonicalFixture(), dependsOn: [{ packId: 'pack-a', packVersion: '>=1' }] }).ok).toBe(false);
    expect(validatePackManifest({ ...canonicalFixture(), dependsOn: [{ packId: 'pack-a', packVersion: 'latest' }] }).ok).toBe(false);
    expect(validatePackManifest({ ...canonicalFixture(), dependsOn: [{ packId: 'pack-fixture', packVersion: '1.0.0' }] }).ok).toBe(false);
    expect(
      validatePackManifest({
        ...canonicalFixture(),
        dependsOn: [{ packId: 'pack-a', packVersion: '1.0.0' }, { packId: 'pack-a', packVersion: '1.0.0' }],
      }).ok,
    ).toBe(false);
  });
});

describe('namespace + duplicate keys (ADR-0026 D9)', () => {
  it('pack-qualified keys round-trip; wrong prefix / empty local name fail closed', () => {
    expect(packQualifiedKey('pack-a', 'b')).toBe('pack-a:b');
    expect(parsePackQualifiedKey('pack-a:b')).toEqual({ packId: 'pack-a', localName: 'b' });
    expect(parsePackQualifiedKey('nocolon')).toBeNull();
    expect(parsePackQualifiedKey('pack-a:')).toBeNull();
    expect(
      validatePackManifest({
        ...canonicalFixture(),
        declarations: {
          ...canonicalFixture().declarations,
          roles: [{ key: 'other-pack:role', label: 'R', authorityRefs: ['workflow.review'] }],
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects a duplicate logical key inside the same category (different categories are separate namespaces)', () => {
    const base = canonicalFixture();
    expect(
      validatePackManifest({
        ...base,
        declarations: {
          ...base.declarations,
          prompts: [{ key: 'pack-fixture:dup', template: 'a', version: null }, { key: 'pack-fixture:dup', template: 'b', version: null }],
        },
      }).ok,
    ).toBe(false);
    // Same local name under a DIFFERENT category is fine (kind-scoped namespaces):
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, prompts: [{ key: 'pack-fixture:reviewer', template: 'a', version: null }] },
      }).ok,
    ).toBe(true);
  });
});

describe('generic template declaration (TASK-15-02 Boss ruling)', () => {
  const base = canonicalFixture();

  it('accepts inert string and structured JSON content', () => {
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t1', kind: 'some-type', content: 'plain string' }] },
      }).ok,
    ).toBe(true);
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t2', kind: 'some-type', content: { a: [1, 2, { b: null }] } }] },
      }).ok,
    ).toBe(true);
  });

  it('rejects empty kind, non-JSON values and unknown fields', () => {
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: '', content: {} }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: Number.NaN }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: (): null => null }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: undefined }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: BigInt(1) }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: Infinity }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: new Date() }] } }).ok).toBe(false);
    expect(validatePackManifest({ ...base, declarations: { ...base.declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: {}, execute: 'rm -rf /' }] } }).ok).toBe(false);
  });

  it('isJsonValue is the JSON-safety oracle; OPAQUE_TOKEN_PATTERN guards `kind`', () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue([1, 'a', { b: [true, null] }])).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue((): null => null)).toBe(false);
    expect(isJsonValue(Buffer.from('x'))).toBe(false); // prototype !== Object.prototype
    expect(isJsonValue(new Map())).toBe(false);
    expect(OPAQUE_TOKEN_PATTERN.test('some-type')).toBe(true);
    expect(OPAQUE_TOKEN_PATTERN.test('Bad Type')).toBe(false);
    const json: JsonValue = { nested: ['ok', 1, false, null] };
    expect(isJsonValue(json)).toBe(true);
  });

  it('neither workflowTemplates nor prompts accept generic-template payloads (categories stay separate)', () => {
    // A template-shaped payload does NOT become a workflow template declaration:
    const t = validatePackManifest({ ...base, declarations: { ...base.declarations, workflowTemplates: [] } });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.value.declarations.workflowTemplates).toHaveLength(0);
    // ...it lives only under declarations.templates.
    const p = validatePackManifest({ ...base, declarations: { ...base.declarations, prompts: [] } });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.declarations.prompts).toHaveLength(0);
  });
});

describe('tool / validator / capability requirements stay declarative', () => {
  const base = canonicalFixture();

  it('tool requirements are references — executable config fields are rejected', () => {
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, tools: [{ key: 'pack-fixture:t', toolId: 'tool.x', capability: null, command: 'ls' }] },
      }).ok,
    ).toBe(false);
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, validators: [{ key: 'pack-fixture:v', validatorId: 'tool.y' }] },
      }).ok,
    ).toBe(true);
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, riskRules: [{ key: 'pack-fixture:r', riskLevel: 'EXTREME' }] },
      }).ok,
    ).toBe(false);
  });

  it('role authority refs must be in the closed catalog (pack.manage included)', () => {
    expect(isAuthority('pack.manage')).toBe(true);
    expect(isAuthority('pack.install')).toBe(false);
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, roles: [{ key: 'pack-fixture:admin', label: 'Admin', authorityRefs: ['pack.manage'] }] },
      }).ok,
    ).toBe(true);
    expect(
      validatePackManifest({
        ...base,
        declarations: { ...base.declarations, roles: [{ key: 'pack-fixture:admin', label: 'Admin', authorityRefs: ['owner'] }] },
      }).ok,
    ).toBe(false);
  });
});
