/**
 * Sprint 13A reconciliation (ADR-0017): `targetRef` — the durable binding between a
 * Validation and the EXACT artifact under validation. Deliberately separate from
 * `evidenceRefs` (target ≠ evidence). `null` is legacy Sprint 1 compatibility only.
 */
import { describe, expect, it } from 'vitest';

import {
  artifactTargetRef,
  createValidation,
  isValidationTargetRef,
} from '../../src/index.js';

const baseInput = {
  runId: 'run_01JT13' as never,
  validatorId: 'pack-x:unit',
  validatorVersion: '1.0.0',
  status: 'pass' as const,
  exitCode: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  ids: (() => {
    let n = 0;
    return { id: (prefix = 'id') => `${prefix}_01JT13${String(++n).padStart(4, '0')}`, ulid: () => `01JT13${String(++n).padStart(20, '0')}` };
  })(),
};

describe('ValidationTargetRef (ADR-0017)', () => {
  it('mints and recognises the canonical artifact target ref', () => {
    const ref = artifactTargetRef('art_01JT1300000000000000AA');
    expect(ref).toBe('artifact:art_01JT1300000000000000AA');
    expect(isValidationTargetRef(ref)).toBe(true);
  });

  it('rejects non-canonical target refs', () => {
    expect(isValidationTargetRef('art_01JT1300000000000000AA')).toBe(false); // missing prefix
    expect(isValidationTargetRef('artifact:art_x')).toBe(false); // ulid body too short
    expect(isValidationTargetRef('artifact:command_01JT1300000000000000AA')).toBe(false); // wrong id prefix
    expect(isValidationTargetRef('artifact:')).toBe(false);
    expect(isValidationTargetRef(42)).toBe(false);
  });

  it('accepts a canonical targetRef and preserves it on the record', () => {
    const created = createValidation({
      ...baseInput,
      targetRef: artifactTargetRef('art_01JT1300000000000000AA'),
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.targetRef).toBe('artifact:art_01JT1300000000000000AA');
    }
  });

  it('rejects a malformed targetRef (fail closed at the domain boundary)', () => {
    const created = createValidation({
      ...baseInput,
      targetRef: 'artifact:art_x' as never,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('INVALID_ARGUMENT');
  });

  it('keeps legacy compatibility: omitted/undefined targetRef records as null', () => {
    const legacy = createValidation(baseInput);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value.targetRef).toBeNull();
  });

  it('keeps targetRef independent from evidenceRefs (target ≠ evidence)', () => {
    // targetRef present but evidenceRefs untouched (and vice versa):
    const targeted = createValidation({
      ...baseInput,
      status: 'fail' as const,
      exitCode: 1,
      targetRef: artifactTargetRef('art_01JT1300000000000000AA'),
      evidenceRefs: ['command:pnpm test'],
    });
    expect(targeted.ok).toBe(true);
    if (targeted.ok) {
      expect(targeted.value.targetRef).toBe('artifact:art_01JT1300000000000000AA');
      expect(targeted.value.evidenceRefs).toEqual(['command:pnpm test']);
    }

    // A legacy record with no target can still carry evidence — the two never merge:
    const legacy = createValidation({ ...baseInput, evidenceRefs: ['artifact:art_01JT1300000000000000AA'] });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.value.targetRef).toBeNull();
      expect(legacy.value.evidenceRefs).toContain('artifact:art_01JT1300000000000000AA');
    }
  });

  it('leaves the blocking quality gate semantics untouched', () => {
    const targeted = createValidation({
      ...baseInput,
      targetRef: artifactTargetRef('art_01JT1300000000000000AA'),
    });
    expect(targeted.ok).toBe(true);
    if (targeted.ok) expect(targeted.value.blocking).toBe(true);
  });
});
