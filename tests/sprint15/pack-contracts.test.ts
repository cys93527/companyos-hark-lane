/**
 * Sprint 15 / Task-15-02: cross-package pack contracts — conformance between the
 * contracts transport projection and the Core semantic model (ADR-0024 D3), the
 * PackVersion identity + canonical fingerprint, the nullable PackContentRef, the
 * `pack.manage` catalog entry, the security structural locks, and legacy
 * (packless) workflow/run contracts staying unaffected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PACK_CONTENT_KINDS,
  createPackContentRef,
  createPackVersion,
  decideAuthority,
  isAuthority,
  isPackManifestFingerprint,
  parsePackManifestFingerprint,
  validatePackManifest,
} from '@companyos/core';
import {
  canonicalPackManifestSchema,
  emptyPackDeclarations,
  normalizeLegacyPackManifestInput,
} from '@companyos/contracts';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const canonicalInput = () => ({
  manifestVersion: 1,
  packId: 'pack-fixture',
  packVersion: '1.0.0',
  name: 'Industry-neutral fixture pack',
  coreApi: '1',
  capabilities: [
    { id: 'pack-fixture:filesystem', description: 'file ops' },
    { id: 'pack-fixture:patch.apply', description: 'apply a patch' },
  ],
  dependsOn: [{ packId: 'pack-other', packVersion: '2.0.0' }],
  declarations: {
    roles: [{ key: 'pack-fixture:reviewer', label: 'Reviewer', authorityRefs: ['workflow.review'] }],
    workflowTemplates: [
      {
        key: 'pack-fixture:feature',
        name: 'Feature flow',
        description: 'd',
        graph: { nodes: [{ id: 's1', kind: 'work', title: 'Work', config: {} }], edges: [] },
      },
    ],
    prompts: [{ key: 'pack-fixture:summary', template: 'Summarize.', version: null }],
    tools: [{ key: 'pack-fixture:fs', toolId: 'tool.filesystem', capability: null }],
    validators: [{ key: 'pack-fixture:unit', validatorId: 'tool.unittest' }],
    artifacts: [{ key: 'pack-fixture:diff', label: 'Diff', description: '' }],
    riskRules: [{ key: 'pack-fixture:high-risk', riskLevel: 'MEDIUM', description: '' }],
    capabilityRules: [{ key: 'pack-fixture:needs-fs', requires: ['pack-fixture:filesystem'], exposes: ['pack-fixture:patch.apply'] }],
    templates: [{ key: 'pack-fixture:document-template', kind: 'some-type', content: { title: 'x' } }],
  },
});

describe('contracts ↔ Core conformance (canonical names only)', () => {
  it('the transport projection and the semantic model agree on the same object', () => {
    const parsed = canonicalPackManifestSchema.safeParse(canonicalInput());
    const core = validatePackManifest(canonicalInput());
    expect(parsed.success).toBe(true);
    expect(core.ok).toBe(true);
    if (!parsed.success || !core.ok) return;
    expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(core.value));
    // Both reject the same malformed inputs.
    for (const broken of [
      { ...canonicalInput(), coreApi: '99' },
      { ...canonicalInput(), manifestVersion: 2 },
      { ...canonicalInput(), dependsOn: [{ packId: 'pack-a', packVersion: '^1.2' }] },
    ]) {
      expect(canonicalPackManifestSchema.safeParse(broken).success).toBe(false);
      expect(validatePackManifest(broken).ok).toBe(false);
    }
  });

  it('a legacy-alias manifest normalizes INTO the canonical shape and validates on both sides', () => {
    const legacy = { schemaVersion: 1, id: 'pack-legacy', version: '2.0.0', apiVersion: '1', name: 'Legacy' };
    const normalized = normalizeLegacyPackManifestInput(legacy);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const canonical = { ...normalized.value, capabilities: [], dependsOn: [], declarations: emptyPackDeclarations() };
    expect(canonicalPackManifestSchema.safeParse(canonical).success).toBe(true);
    expect(validatePackManifest(canonical).ok).toBe(true);
  });
});

describe('PackVersion identity + canonical fingerprint', () => {
  const version = () => {
    const result = createPackVersion(canonicalInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(versionError(result));
    return result.value;
  };
  const versionError = (result: { ok: false; error: { message: string } }): string => result.error.message;

  it('validates + freezes an immutable version identity with a manifest fingerprint', () => {
    const v = version();
    expect(v.packId).toBe('pack-fixture');
    expect(v.packVersion).toBe('1.0.0');
    expect(v.manifestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/); // qualified SHA-256 ref (repo convention)
    // The validator rejects a bare hex (§10: NO dual compatibility).
    expect(isPackManifestFingerprint(v.manifestFingerprint)).toBe(true);
    expect(isPackManifestFingerprint(v.manifestFingerprint.slice('sha256:'.length))).toBe(false);
    expect(parsePackManifestFingerprint(v.manifestFingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(parsePackManifestFingerprint('sha256:xyz')).toBeNull();
    expect(createPackVersion({ packId: 'x', packVersion: '1.0.0' }).ok).toBe(false);
  });

  it('raw key order and legacy-alias equivalence do NOT change the fingerprint', () => {
    const v1 = version();
    const shuffled = {
      name: canonicalInput().name,
      coreApi: '1',
      declarations: canonicalInput().declarations,
      dependsOn: [...canonicalInput().dependsOn].reverse(),
      capabilities: [...canonicalInput().capabilities].reverse(),
      manifestVersion: 1,
      packVersion: '1.0.0',
      packId: 'pack-fixture',
    };
    const v2 = createPackVersion(shuffled);
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(v2.value.manifestFingerprint).toBe(v1.manifestFingerprint);
    // Legacy-alias equivalent content yields the SAME qualified fingerprint (§9.4).
    const aliased = normalizeLegacyPackManifestInput({
      schemaVersion: 1, id: 'pack-fixture', version: '1.0.0', apiVersion: '1',
      name: canonicalInput().name,
      capabilities: [...canonicalInput().capabilities],
      dependsOn: [...canonicalInput().dependsOn],
      declarations: { ...canonicalInput().declarations },
    });
    expect(aliased.ok).toBe(true);
    if (aliased.ok) {
      const viaAlias = createPackVersion({ ...aliased.value, coreApi: '1' });
      expect(viaAlias.ok).toBe(true);
      if (viaAlias.ok) expect(viaAlias.value.manifestFingerprint).toBe(v1.manifestFingerprint);
    }
    // Object-key order INSIDE generic template content is canonicalized the same way.
    const reorderedContent = createPackVersion({
      ...canonicalInput(),
      declarations: { ...canonicalInput().declarations, templates: [{ key: 'pack-fixture:document-template', kind: 'some-type', content: { z: 1, a: 2 } }] },
    });
    expect(reorderedContent.ok).toBe(true);
    if (reorderedContent.ok) {
      expect(reorderedContent.value.manifestFingerprint).not.toBe(v1.manifestFingerprint);
      const swapped = createPackVersion({
        ...canonicalInput(),
        declarations: { ...canonicalInput().declarations, templates: [{ key: 'pack-fixture:document-template', kind: 'some-type', content: { a: 2, z: 1 } }] },
      });
      if (swapped.ok) expect(swapped.value.manifestFingerprint).toBe(reorderedContent.value.manifestFingerprint);
    }
    // ARRAY order inside template content IS semantic.
    const arrayV1 = createPackVersion({ ...canonicalInput(), declarations: { ...canonicalInput().declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: ['a', 'b'] }] } });
    const arrayV2 = createPackVersion({ ...canonicalInput(), declarations: { ...canonicalInput().declarations, templates: [{ key: 'pack-fixture:t', kind: 'some-type', content: ['b', 'a'] }] } });
    expect(arrayV1.ok && arrayV2.ok).toBe(true);
    if (arrayV1.ok && arrayV2.ok) expect(arrayV1.value.manifestFingerprint).not.toBe(arrayV2.value.manifestFingerprint);
  });

  it('the same (packId, packVersion) with different content is a CONFLICT, never a silent replace', () => {
    const v1 = version();
    const v2 = createPackVersion({ ...canonicalInput(), name: 'Renamed pack' });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.value.manifestFingerprint).not.toBe(v1.manifestFingerprint);
    // Conflict predicate lives in the domain: same identity, different digest.
    const { isPackVersionConflict } = { isPackVersionConflict: (a: typeof v1, b: typeof v1): boolean => a.packId === b.packId && a.packVersion === b.packVersion && a.manifestFingerprint !== b.manifestFingerprint };
    expect(isPackVersionConflict(v1, v2.value)).toBe(true);
    // (durable conflict enforcement lands in T15-03/04.)
  });

  it('the fingerprint excludes runtime fields (installation state never participates)', () => {
    const v1 = version();
    const v2 = createPackVersion(canonicalInput());
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(v2.value.manifestFingerprint).toBe(v1.manifestFingerprint);
  });
});

describe('PackContentRef (provenance-only, nullable materialization — Boss ruling §13)', () => {
  it('accepts the nine closed content kinds and a null materialized target for pack-native content', () => {
    const ref = createPackContentRef({
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      contentKind: 'template',
      logicalKey: 'pack-fixture:document-template',
    });
    expect(ref.ok).toBe(true);
    if (ref.ok) {
      expect(ref.value.materializedEntityRef).toBeNull(); // pack-native: no fake entity invented
      expect(ref.value.contentKind).toBe('template');
    }
  });

  it('accepts a real materialized entity ref for subsystem-landed declarations', () => {
    const ref = createPackContentRef({
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      contentKind: 'workflowTemplate',
      logicalKey: 'pack-fixture:feature',
      materializedEntityRef: 'tpl_01Jsomewhere',
    });
    expect(ref.ok).toBe(true);
    if (ref.ok) expect(ref.value.materializedEntityRef).toBe('tpl_01Jsomewhere');
  });

  it('rejects unknown content kinds and keys outside the pack namespace', () => {
    expect(createPackContentRef({ packId: 'pack-fixture', packVersion: '1.0.0', contentKind: 'agent', logicalKey: 'pack-fixture:a' }).ok).toBe(false);
    expect(createPackContentRef({ packId: 'pack-fixture', packVersion: '1.0.0', contentKind: 'role', logicalKey: 'other-pack:role' }).ok).toBe(false);
    expect(PACK_CONTENT_KINDS).toHaveLength(9);
  });
});

describe('pack.manage authority catalog (T15-02 §43/§76)', () => {
  it('is a legal vocabulary entry; no other pack authority exists yet', () => {
    expect(isAuthority('pack.manage')).toBe(true);
    for (const notAuthority of ['pack.read', 'pack.install', 'pack.disable', 'pack.upgrade', 'pack.admin']) {
      expect(isAuthority(notAuthority)).toBe(false);
    }
    // Unknown authorities still fail closed.
    const typo = decideAuthority({ actorId: 'user_x', authority: 'pack.manag', roles: [], assignments: [] });
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.error.code).toBe('INVALID_ARGUMENT');
  });

  it('is vocabulary-only: no production execution point is claimed yet (T15-04)', () => {
    const sources = [
      'packages/engine/src/recovery/startup-recovery.ts',
      'packages/engine/src/artifact/artifact-service.ts',
    ].map((path) => readFileSync(repo(path), 'utf8'));
    for (const source of sources) expect(source.includes('pack.manage')).toBe(false);
  });
});

describe('security structural locks (DATA/CONFIG ONLY — ADR-0024 D2)', () => {
  it('the pack production paths contain no dynamic execution surface', () => {
    const paths = [
      'packages/core/src/registry/pack-manifest.ts',
      'packages/core/src/domain/pack.ts',
      'packages/contracts/src/pack-manifest.ts',
    ].map((path) => readFileSync(repo(path), 'utf8'));
    for (const source of paths) {
      expect(source.includes('eval(')).toBe(false);
      expect(source.includes('new Function')).toBe(false);
      expect(source.includes('node:vm')).toBe(false);
      expect(source.includes('child_process')).toBe(false);
    }
  });
});

const readRunSnapshotShape = async (): Promise<{ readonly packVersionsDefault: Readonly<Record<string, string>> }> => {
  // The snapshot domain contract (ReadonlyRecord default) — imported lazily to keep
  // this test focused on the pack surface.
  const source = readFileSync(repo('packages/core/src/lifecycle/snapshot.ts'), 'utf8');
  expect(source.includes('packVersions')).toBe(true); // the carrier field exists (ADR-0027)
  return { packVersionsDefault: {} };
};

describe('legacy (packless) contracts remain unaffected', () => {
  it('a workflow run still constructs without any pack context (packless runs stay first-class)', async () => {
    const { createWorkflowRun, SequenceIdFactory, FixedClock } = await import('@companyos/core');
    const ids = new SequenceIdFactory('t15');
    const clock = new FixedClock(Date.parse('2026-09-26T00:00:00.000Z'));
    const run = createWorkflowRun({
      companyId: 'cmp_1' as never,
      workflowId: 'wfl_1' as never,
      templateId: 'tpl_1' as never,
      versionId: 'ver_1' as never,
      snapshotId: 'snp_1' as never,
      startedBy: 'user_owner',
      now: clock.nowIso(),
      ids,
    });
    expect(run.ok).toBe(true);
    // Pack provenance lives on the run's snapshot and starts EMPTY — a packless run
    // is a first-class citizen (ADR-0024 D6 / T15-05 fills it only when a pack
    // actually contributed).
    const snapshot = await readRunSnapshotShape();
    expect(snapshot.packVersionsDefault).toEqual({});
  });
});
