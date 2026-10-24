/**
 * Sprint 15 / Task-15-02: the contracts TRANSPORT PROJECTION of the canonical pack
 * manifest (ADR-0024: Core is the semantic authority). Covers strictness, the legacy
 * alias normalization shim (ambiguity = rejection), and one-to-one conformance with
 * the Core semantic model.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalPackManifestSchema,
  emptyPackDeclarations,
  isEmptyPack,
  normalizeLegacyPackManifestInput,
  parseOrThrow,
} from '../src/index.js';

const canonicalInput = () => ({
  manifestVersion: 1,
  packId: 'pack-fixture',
  packVersion: '1.0.0',
  name: 'Industry-neutral fixture pack',
  coreApi: '1',
  capabilities: [{ id: 'pack-fixture:patch.apply', description: 'apply a patch' }],
  dependsOn: [{ packId: 'pack-other', packVersion: '2.0.0' }],
  declarations: {
    ...emptyPackDeclarations(),
    roles: [{ key: 'pack-fixture:reviewer', label: 'Reviewer', authorityRefs: ['workflow.review'] }],
    templates: [{ key: 'pack-fixture:document-template', kind: 'some-type', content: { a: [1, { b: null }] } }],
  },
});

describe('canonical transport schema (one-to-one projection of the Core model)', () => {
  it('accepts the canonical shape; the remaining declaration categories are explicit empty lists', () => {
    const manifest = parseOrThrow(canonicalPackManifestSchema, canonicalInput(), 'PackManifest');
    expect(manifest.packId).toBe('pack-fixture');
    expect(manifest.declarations.roles[0]?.key).toBe('pack-fixture:reviewer');
    expect(manifest.declarations.workflowTemplates).toEqual([]);
    expect(isEmptyPack(manifest)).toBe(false);
    expect(
      isEmptyPack(
        parseOrThrow(
          canonicalPackManifestSchema,
          { ...canonicalInput(), capabilities: [], declarations: emptyPackDeclarations(), dependsOn: [] },
          'PackManifest',
        ),
      ),
    ).toBe(true);
  });

  it('rejects unknown fields, legacy spellings and non-exact dependencies (never strips)', () => {
    expect(canonicalPackManifestSchema.safeParse({ ...canonicalInput(), description: 'x' }).success).toBe(false);
    expect(canonicalPackManifestSchema.safeParse({ ...canonicalInput(), id: 'pack-fixture' }).success).toBe(false);
    expect(canonicalPackManifestSchema.safeParse({ ...canonicalInput(), version: '1.0.0' }).success).toBe(false);
    expect(canonicalPackManifestSchema.safeParse({ ...canonicalInput(), schemaVersion: 1 }).success).toBe(false);
    expect(canonicalPackManifestSchema.safeParse({ ...canonicalInput(), provides: {} }).success).toBe(false);
    expect(
      canonicalPackManifestSchema.safeParse({
        ...canonicalInput(),
        declarations: { ...canonicalInput().declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: {}, handler: 'x' }] },
      }).success,
    ).toBe(false);
    expect(
      canonicalPackManifestSchema.safeParse({
        ...canonicalInput(),
        dependsOn: [{ packId: 'pack-a', packVersion: '^1.2' }],
      }).success,
    ).toBe(false);
  });
});

describe('legacy alias normalization (deprecated Sprint 0 shim)', () => {
  it('maps legacy aliases to canonical names', () => {
    const result = normalizeLegacyPackManifestInput({
      schemaVersion: 1,
      id: 'pack-legacy',
      version: '2.0.0',
      coreApi: '1',
      name: 'Legacy',
      description: 'transport-only extra',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({
      coreApi: '1',
      name: 'Legacy',
      description: 'transport-only extra',
      manifestVersion: 1,
      packId: 'pack-legacy',
      packVersion: '2.0.0',
    });
  });

  it('REJECTS a conflicting dual naming instead of silently picking one', () => {
    const both = normalizeLegacyPackManifestInput({ id: 'pack-a', packId: 'pack-b', version: '1.0.0', coreApi: '1', name: 'x' });
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.error).toContain('conflicting');
    const versionConflict = normalizeLegacyPackManifestInput({ version: '1.0.0', packVersion: '2.0.0', coreApi: '1', name: 'x' });
    expect(versionConflict.ok).toBe(false);
  });

  it('maps apiVersion / coreApiRange to canonical coreApi (when not conflicting)', () => {
    const result = normalizeLegacyPackManifestInput({ id: 'pack-a', version: '1.0.0', apiVersion: '1', name: 'A' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value['coreApi']).toBe('1');
  });

  it('legacy `provides` (bare name lists) is NOT carried into canonical declarations', () => {
    const result = normalizeLegacyPackManifestInput({ id: 'pack-a', version: '1.0.0', coreApi: '1', name: 'A', provides: { roles: ['dev'] } });
    expect(result.ok).toBe(false);
  });
});
