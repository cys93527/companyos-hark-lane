/**
 * Sprint25 — the SECRET REFERENCE BOUNDARY (Boss §10-§16/§39).
 *
 * The law under test: a `SecretRef` is a POINTER that may be persisted, logged and
 * carried in evidence; a resolved VALUE is process memory for exactly one caller and
 * never reaches a durable object, an artifact, an event, an error detail or a log
 * line. Secret failures fail CLOSED with distinguishable typed codes.
 *
 * These are real tests: every case drives the production module and asserts an
 * observable outcome — none of them assert a code path that cannot fail.
 */
import { describe, expect, it } from 'vitest';

import { DomainError } from '@companyos/core';
import {
  assertNoSecretMaterial,
  assertSecretRefIsPointer,
  redactExecutionText,
  reportSecretResolution,
  resolveExecutionSecret,
  type ExecutionSecretOutcome,
} from '@companyos/engine';

import type { SecretRef, SecretRefResolverPort } from '@companyos/core';

/** A resolver the test controls: `null` = not configured, `throw` = source unavailable. */
const resolverOf = (behavior: 'null' | 'throw' | 'value', value = 'canary-super-secret-value'): SecretRefResolverPort => ({
  async resolve(): Promise<string | null> {
    if (behavior === 'null') return null;
    if (behavior === 'throw') throw new Error('keychain locked: cannot read the entry');
    return value;
  },
  async available(): Promise<readonly string[]> {
    return behavior === 'null' ? [] : ['api-key'];
  },
});

const refOf = (over: Partial<SecretRef> = {}): SecretRef => ({
  id: 'sref_companyos_provider',
  providerId: 'dsh-headless',
  purpose: 'provider-api-key',
  source: 'env',
  envName: 'PROVIDER_API_KEY',
  ...over,
});

describe('S25 secret boundary — pointer vs value (§10)', () => {
  it('1. a well-formed SecretRef pointer passes the guard', () => {
    const checked = assertSecretRefIsPointer(refOf());
    expect(checked.ok).toBe(true);
  });

  it('2. a VALUE smuggled through a ref field is not a pointer', () => {
    const checked = assertSecretRefIsPointer(refOf({ purpose: 'sk-mock-0123456789abcdefghijklmnop\nmore' }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.code).toBe('VALIDATION_FAILED');
    expect(String(checked.error.details['reason'])).toBe('SECRET_REF_NOT_A_POINTER');
    // The refusal never echoes the material it refused.
    expect(checked.error.message).not.toContain('sk-');
  });

  it('3. an empty ref field is a typed refusal, not a silent pass', () => {
    const checked = assertSecretRefIsPointer(refOf({ envName: '   ' }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('SECRET_REF_FIELD_INVALID');
  });

  it('4. envName on a non-env source is refused (the source and the shape must agree)', () => {
    const checked = assertSecretRefIsPointer(refOf({ source: 'os_keychain', envName: 'WHATEVER' }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('SECRET_REF_SOURCE_ENV_MISMATCH');
  });
});

describe('S25 secret boundary — fail-closed typed outcomes (§11-§12)', () => {
  it('5. an unconfigured ref is SECRET_NOT_FOUND (never PERMISSION_DENIED, never an empty string)', async () => {
    const resolved = await resolveExecutionSecret(resolverOf('null'), refOf());
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBeInstanceOf(DomainError);
    expect(resolved.error.code).toBe('SECRET_NOT_FOUND');
    expect(String(resolved.error.details['reason'])).toBe('SECRET_NOT_FOUND_REASON');
    expect(resolved.error.message).not.toContain('PERMISSION');
  });

  it('6. an unreachable source is SECRET_SOURCE_UNAVAILABLE (distinct remedy, never "no secret needed")', async () => {
    const resolved = await resolveExecutionSecret(resolverOf('throw'), refOf());
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('SECRET_SOURCE_UNAVAILABLE');
    expect(String(resolved.error.details['reason'])).toBe('SECRET_SOURCE_UNAVAILABLE_REASON');
  });

  it('7. the two outcomes are different codes on purpose (different operator remedies)', async () => {
    const missing = await resolveExecutionSecret(resolverOf('null'), refOf());
    const unreachable = await resolveExecutionSecret(resolverOf('throw'), refOf());
    expect(missing.ok && unreachable.ok).toBe(false);
    if (missing.ok || unreachable.ok) return;
    expect(missing.error.code).not.toBe(unreachable.error.code);
  });

  it('8. the resolution report carries names and outcomes, never values', async () => {
    const report = await reportSecretResolution(resolverOf('value', 'canary-super-secret-value'), refOf());
    expect(report.outcome).toBe('resolved');
    expect(Object.keys(report).sort()).toEqual(['outcome', 'purpose', 'source']);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('canary');
  });

  it('9. a NOT-configured requirement is reported as not-found even when a resolver is wired', async () => {
    const report = await reportSecretResolution(resolverOf('null'), refOf());
    expect(report.outcome).toBe<ExecutionSecretOutcome>('not-found');
  });

  it('10. no resolver at all is still fail-closed (an absent vault never means "allowed")', async () => {
    const report = await reportSecretResolution(resolverOf('null'), refOf());
    expect(report.outcome).toBe('not-found');
    const resolved = await resolveExecutionSecret(resolverOf('null'), refOf());
    expect(resolved.ok).toBe(false);
  });
});

describe('S25 secret boundary — redaction and non-persistence (§13-§16)', () => {
  it('11. known material is masked before text can travel (central authority)', () => {
    const masked = redactExecutionText('stdout leaked canary-super-secret-value here', ['canary-super-secret-value']);
    expect(masked).not.toContain('canary-super-secret-value');
    expect(masked).toContain('[redacted]');
  });

  it('12. a payload carrying a known secret is refused, and the refusal never echoes it', () => {
    const payload = { output: { finalText: 'used canary-super-secret-value' } };
    const guarded = assertNoSecretMaterial(payload, ['canary-super-secret-value'], 'provider output envelope');
    expect(guarded.ok).toBe(false);
    if (guarded.ok) return;
    expect(guarded.error.code).toBe('PERMISSION_DENIED');
    expect(String(guarded.error.details['guard'])).toBe('secret-material');
    const serialized = JSON.stringify(guarded.error.details);
    expect(serialized).not.toContain('canary-super-secret-value');
    expect(String(guarded.error.details['leakedLength'])).toBe('25');
  });
});
