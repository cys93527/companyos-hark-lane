/**
 * Sprint 13A / Task-13-01 regression: `ARTIFACT` joins the memory provenance closed
 * set (ADR-0015/0016 — additive extension only). The closed-set membership is what the
 * Task-13-08 composition-root verifier will rely on; content is never copied.
 */
import { describe, expect, it } from 'vitest';

import { MEMORY_SOURCE_TYPES, createMemoryRecord } from '../../src/index.js';

const baseInput = {
  companyId: 'cmp_1',
  scope: { type: 'COMPANY' as const, id: 'cmp_1' },
  kind: 'FACT' as const,
  title: 'Policy',
  content: 'Use SQLite',
  importance: 'HIGH' as const,
  createdBy: 'actor',
  traceId: 'trace',
  metadata: {},
};

describe('memory provenance source types (Sprint 13A additive extension)', () => {
  it('includes ARTIFACT in the closed set, additively', () => {
    expect(MEMORY_SOURCE_TYPES).toContain('ARTIFACT');
    expect(MEMORY_SOURCE_TYPES).toHaveLength(7);
  });

  it('accepts an ARTIFACT source only with source references', () => {
    const accepted = createMemoryRecord({
      ...baseInput,
      memoryId: 'mem_art',
      sourceType: 'ARTIFACT',
      sourceRefs: ['artifact:art_01JTEST'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.provenance.sourceType).toBe('ARTIFACT');
      expect(accepted.value.content).toBe('Use SQLite');
    }

    // Non-user/system sources still require at least one reference.
    const missingRefs = createMemoryRecord({
      ...baseInput,
      memoryId: 'mem_art_noref',
      sourceType: 'ARTIFACT',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(missingRefs.ok).toBe(false);
  });

  it('still rejects unknown source types (fail closed)', () => {
    const rejected = createMemoryRecord({
      ...baseInput,
      memoryId: 'mem_bad',
      sourceType: 'ARTIFACT_V2' as never,
      sourceRefs: ['artifact:art_01JTEST'],
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    expect(rejected.ok).toBe(false);
  });
});
