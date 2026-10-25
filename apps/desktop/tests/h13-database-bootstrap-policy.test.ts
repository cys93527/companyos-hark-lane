// H13 — a downgraded build refuses a newer database ONCE; later IPC calls never re-open it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDatabaseBootstrapRetryable } from '../src/database-bootstrap-policy.js';

describe('database bootstrap retry policy', () => {
  it('a newer-schema refusal is terminal for the process', () => {
    expect(isDatabaseBootstrapRetryable({ code: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations: ['0010_h13_upgrade_probe'] })).toBe(false);
  });
  it('an open failure, or no failure yet, may be retried', () => {
    expect(isDatabaseBootstrapRetryable({ code: 'OPEN_FAILED', message: 'SQLITE_BUSY' })).toBe(true);
    expect(isDatabaseBootstrapRetryable(null)).toBe(true);
  });
  it('the lazy workflow bootstrap consults the policy before re-opening', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/shellDatabase \?\? \(isDatabaseBootstrapRetryable\(databaseFailure\) \? bootstrapDatabase\(activeLogger\) : null\)/u);
    expect(main.match(/bootstrapDatabase\(/gu)?.length).toBe(3); // definition + startup + guarded lazy retry
  });
});
