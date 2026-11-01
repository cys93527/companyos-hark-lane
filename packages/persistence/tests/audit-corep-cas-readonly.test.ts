/**
 * AUDIT-D4 (corep part, defence in depth) — a published CAS object is sealed read-only so
 * an external editor handed the object cannot silently rewrite bytes whose address is their
 * own hash. Publication, dedupe/reuse, reads and directory cleanup keep working.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFilesystemArtifactContentStore } from '../src/index.js';

const created: string[] = [];
afterEach(() => {
  created.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'companyos-cas-ro-'));
  created.push(root);
  return root;
};
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const digestOf = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
const finalPathFor = (root: string, hex: string): string => join(root, hex.slice(0, 2), hex);
const writable = (path: string): boolean => (statSync(path).mode & 0o222) !== 0;

describe('AUDIT-D4 CAS objects are sealed read-only', () => {
  it('a freshly published object carries no write permission and still reads/verifies', async () => {
    const root = makeRoot();
    const store = createFilesystemArtifactContentStore({ casRoot: root });
    const stored = await store.put(text('report body'));
    const path = finalPathFor(root, digestOf(text('report body')));
    expect(writable(path)).toBe(false);
    expect(new TextDecoder().decode(await store.get(stored.contentRef))).toBe('report body');
    expect(await store.verify(stored.contentRef)).toMatchObject({ status: 'valid' });
    // No staging residue is left behind (the read-only seal never blocks staging cleanup).
    expect(existsSync(join(root, 'staging')) ? readdirSync(join(root, 'staging')) : []).toEqual([]);
  });

  it('dedupe of the same bytes reuses the sealed object, and an older writable object is re-sealed', async () => {
    const root = makeRoot();
    const content = text('legacy object');
    const hex = digestOf(content);
    // An object published by an older build (writable).
    mkdirSync(join(root, hex.slice(0, 2)), { recursive: true });
    writeFileSync(finalPathFor(root, hex), content);
    chmodSync(finalPathFor(root, hex), 0o644);

    const store = createFilesystemArtifactContentStore({ casRoot: root });
    const first = await store.put(content);
    expect(first.contentRef).toBe(`sha256:${hex}`);
    expect(writable(finalPathFor(root, hex))).toBe(false);
    const second = await store.put(content);
    expect(second.contentRef).toBe(first.contentRef);
    expect(writable(finalPathFor(root, hex))).toBe(false);
  });

  it('the CAS root (with sealed objects) can still be removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companyos-cas-ro-'));
    const store = createFilesystemArtifactContentStore({ casRoot: root });
    await store.put(text('to be removed'));
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });
});
