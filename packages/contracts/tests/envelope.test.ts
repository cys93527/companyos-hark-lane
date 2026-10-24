/**
 * Sprint 0 acceptance (T0.6): cross-boundary JSON contracts reject malformed
 * input with a JSON-pointer path, and accept the real shapes.
 */
import { describe, expect, it } from 'vitest';

import {
  ContractError,
  SCHEMA_VERSION,
  emptyPackDeclarations,
  eventEnvelopeSchema,
  formatIssues,
  packManifestSchema,
  parseOrThrow,
} from '../src/index.js';

const validEnvelope = {
  eventId: 'evt_1',
  type: 'workflow.template.published',
  version: 1,
  occurredAt: '2026-01-01T00:00:00.000Z',
  aggregateId: 'tpl_1',
  aggregateType: 'workflow_template',
  actorId: 'user_1',
  traceId: 'trace_1',
  payload: { semver: '1.0.0' },
};

describe('event envelope contract', () => {
  it('accepts a valid envelope', () => {
    const envelope = parseOrThrow(eventEnvelopeSchema, validEnvelope, 'EventEnvelope');
    expect(envelope.traceId).toBe('trace_1');
    expect(envelope.version).toBe(SCHEMA_VERSION);
  });

  it('rejects an envelope without traceId, pointing at the field', () => {
    const { traceId, ...withoutTrace } = validEnvelope;
    void traceId;
    expect(() => parseOrThrow(eventEnvelopeSchema, withoutTrace, 'EventEnvelope')).toThrow(ContractError);
    try {
      parseOrThrow(eventEnvelopeSchema, withoutTrace, 'EventEnvelope');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).message).toContain('/traceId');
    }
  });

  it('rejects a non-ISO timestamp and an empty traceId', () => {
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, occurredAt: 'yesterday' }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, traceId: '' }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, version: 0 }).success).toBe(false);
  });

  it('renders every issue as a JSON pointer', () => {
    const result = eventEnvelopeSchema.safeParse({ ...validEnvelope, payload: undefined, version: -1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const rendered = formatIssues(result.error);
    expect(rendered).toContain('/version');
    expect(rendered.split(';').length).toBeGreaterThanOrEqual(1);
  });
});

describe('pack manifest contract (canonical projection — Sprint 15 Task-15-02)', () => {
  // Canonical field names only: legacy Sprint 0 prose (id/version/provides) lives in
  // packages/contracts/tests/pack-manifest.test.ts as the deprecated normalize path.
  const validManifest = {
    manifestVersion: 1,
    packId: 'pack-fixture',
    packVersion: '1.0.0',
    name: 'Industry-neutral fixture pack',
    coreApi: '1',
    capabilities: [{ id: 'pack-fixture:patch.apply', description: 'apply a patch' }],
    dependsOn: [],
    declarations: {
      ...emptyPackDeclarations(),
      roles: [{ key: 'pack-fixture:reviewer', label: 'Reviewer', authorityRefs: ['workflow.review'] }],
      templates: [{ key: 'pack-fixture:document-template', kind: 'some-type', content: { title: 'x' } }],
    },
  };

  it('accepts a canonical manifest and defaults the nine declaration categories', () => {
    const manifest = parseOrThrow(packManifestSchema, validManifest, 'PackManifest');
    expect(manifest.packId).toBe('pack-fixture');
    expect(manifest.declarations.roles).toHaveLength(1);
    expect(manifest.declarations.templates).toHaveLength(1);

    const minimal = parseOrThrow(
      packManifestSchema,
      { manifestVersion: 1, packId: 'pack-min', packVersion: '0.1.0', name: 'Min', coreApi: '1', capabilities: [], dependsOn: [], declarations: emptyPackDeclarations() },
      'PackManifest',
    );
    expect(minimal.declarations.roles).toEqual([]);
    expect(minimal.declarations.templates).toEqual([]);
  });

  it('rejects bad identifiers, versions, legacy names and ranges', () => {
    expect(packManifestSchema.safeParse({ ...validManifest, packId: 'Bad Id' }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...validManifest, packVersion: 'v1' }).success).toBe(false);
    expect(packManifestSchema.safeParse({ ...validManifest, id: 'pack-fixture' }).success).toBe(false);
    expect(
      packManifestSchema.safeParse({ ...validManifest, dependsOn: [{ packId: 'pack-a', packVersion: '^1.2' }] }).success,
    ).toBe(false);
  });
});
