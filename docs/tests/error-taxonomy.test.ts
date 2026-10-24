/**
 * The STATE_MACHINE.md error-taxonomy mirror must equal the shipped union.
 *
 * AGENTS §0.1 says the machine implementation and its mirror move together; this test is that
 * promise as an assertion (Sprint 8 closeout: the mirror had silently fallen 7 codes behind).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@companyos/core';

const doc = readFileSync(fileURLToPath(new URL('../STATE_MACHINE.md', import.meta.url)), 'utf8');
const start = doc.indexOf('```text', doc.indexOf('### 11.3'));
const end = doc.indexOf('```', start + 7);
const block = doc.slice(start + 7, end);

describe('STATE_MACHINE §11.3 mirrors the shipped ERROR_CODES union', () => {
  it('finds the taxonomy block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(100);
  });

  it('lists every shipped code', () => {
    const missing = [...ERROR_CODES].filter((code) => !block.includes(code));
    expect(missing).toEqual([]);
  });

  it('lists no code that is not shipped', () => {
    const listed = new Set(block.match(/[A-Z][A-Z_]+/g) ?? []);
    const shipped = new Set<string>(ERROR_CODES);
    const extra = [...listed].filter((code) => !shipped.has(code));
    expect(extra).toEqual([]);
  });
});
