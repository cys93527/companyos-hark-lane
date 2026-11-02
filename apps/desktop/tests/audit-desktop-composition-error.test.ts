/**
 * AUDIT-D13: every early return of the core composition records its reason (lastCoreCompositionError + log), and
 * main.ts shows that reason instead of the generic "workflow service unavailable".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { composeCoreServices, lastCoreCompositionError } from '../src/core-services.js';

const src = readFileSync(join(__dirname, '../src/core-services.ts'), 'utf8');
const body = src.slice(src.indexOf('const fail = (message: string): null => {'), src.indexOf('let lastCompositionError: string | null = null;'));

describe('AUDIT-D13 composition failure reason is kept', () => {
  it('no early return bypasses fail()', () => {
    expect(body.length).toBeGreaterThan(1000);
    // the only direct assignment is inside fail() itself
    expect(body.match(/compositionError = /g)).toHaveLength(1);
    expect(body.match(/return fail\(/g)!.length).toBeGreaterThanOrEqual(14);
    expect(body).not.toMatch(/compositionError = `[^`]*`;\s+return null;/);
  });

  it('a failing composition sets lastCoreCompositionError and logs it', async () => {
    const errors: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = { debug() {}, info() {}, warn() {}, error(msg: string, fields?: Record<string, unknown>) { errors.push({ msg, fields }); }, child() { return logger; } };
    const result = await composeCoreServices({} as never, logger as never, {} as never);
    expect(result).toBeNull();
    const reason = lastCoreCompositionError();
    expect(typeof reason).toBe('string');
    expect(reason!.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.msg === 'core services composition failed' && e.fields?.['error'] === reason)).toBe(true);
  });

  it('main.ts copies the reason into workflowError', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain("workflowError = lastCoreCompositionError() ?? 'core services composition failed';");
  });
});
