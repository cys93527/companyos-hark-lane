/**
 * Sprint 13 / Task-13-03: filesystem content-addressed storage (ADR-0015 D3/D13).
 *
 * Covers: byte round-trips (text/empty/binary), SHA-256 addressing, race-safe
 * no-clobber publication (concurrent same/different content), existing-object reuse
 * vs corrupt-target fail closed, read integrity verification, malformed-ref and
 * path-injection refusal, staging separation.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactContentStore } from '@companyos/core';
import { createFilesystemArtifactContentStore } from '../src/index.js';

const created: string[] = [];

const makeStore = (): { store: ArtifactContentStore; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'companyos-cas-'));
  created.push(root);
  return { store: createFilesystemArtifactContentStore({ casRoot: root }), root };
};

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const digestOf = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');
const finalPathFor = (root: string, hex: string): string => join(root, hex.slice(0, 2), hex);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const bytesOnDisk = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('CAS basic round-trips', () => {
  it('stores and reads back text bytes byte-identically with canonical lowercase sha256', async () => {
    const { store } = makeStore();
    const content = text('CompanyOS artifact content');
    const stored = await store.put(content);
    expect(stored.contentRef).toBe(`sha256:${stored.contentHash}`);
    expect(/^[0-9a-f]{64}$/.test(stored.contentHash)).toBe(true);
    expect(stored.contentHash).toBe(stored.contentHash.toLowerCase());
    expect(stored.sizeBytes).toBe(content.byteLength);
    await expect(store.get(stored.contentRef)).resolves.toEqual(content);
  });

  it('treats empty content as a valid object (sizeBytes >= 0 contract)', async () => {
    const { store } = makeStore();
    const stored = await store.put(new Uint8Array(0));
    expect(stored.contentHash).toBe(EMPTY_SHA);
    expect(stored.sizeBytes).toBe(0);
    await expect(store.get(stored.contentRef)).resolves.toEqual(new Uint8Array(0));
  });

  it('round-trips binary-transparent bytes (0x00, non-UTF8 sequences)', async () => {
    const { store } = makeStore();
    const binary = Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x00, 0xc3, 0x28]);
    const stored = await store.put(binary);
    await expect(store.get(stored.contentRef)).resolves.toEqual(binary);
  });

  it('maps same bytes to the same ref/hash and different bytes to different refs', async () => {
    const { store } = makeStore();
    const first = await store.put(text('same'));
    const second = await store.put(text('same'));
    const other = await store.put(text('different'));
    expect(second.contentRef).toBe(first.contentRef);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(other.contentRef).not.toBe(first.contentRef);
    expect(other.contentHash).not.toBe(first.contentHash);
  });

  it('honours an expectedHash as verification only — the digest is always recomputed', async () => {
    const { store } = makeStore();
    const content = text('verify me');
    await expect(store.put(content, 'b'.repeat(64))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'CAS_HASH_EXPECTATION_MISMATCH' },
    });
    // A false claim is REFUSED (verification only) — it can never redefine the truth:
    await expect(store.put(content, EMPTY_SHA)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'CAS_HASH_EXPECTATION_MISMATCH' },
    });
    const correct = await store.put(content, digestOf(content));
    expect(correct.contentHash).toBe(digestOf(content));
  });
});

describe('CAS integrity (fail closed)', () => {
  it('fails closed on read and verify when the published bytes were tampered with', async () => {
    const { store, root } = makeStore();
    const stored = await store.put(text('tamper target'));
    const hex = stored.contentRef.slice('sha256:'.length);
    writeFileSync(finalPathFor(root, hex), text('TAMPERED'));

    await expect(store.get(stored.contentRef)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'CAS_CONTENT_HASH_MISMATCH' },
    });
    expect(await store.verify(stored.contentRef)).toEqual({ status: 'hash-mismatch' });
  });

  it('refuses to overwrite a corrupt published object and fails closed (ADR-0015 D13)', async () => {
    const { store, root } = makeStore();
    const content = text('the real content');
    const hex = digestOf(content);
    mkdirSync(join(root, hex.slice(0, 2)), { recursive: true });
    writeFileSync(finalPathFor(root, hex), text('CORRUPT OBJECT'));

    await expect(store.put(content)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'CAS_CONTENT_HASH_MISMATCH' },
    });
    // The corrupt object was NOT overwritten with the new bytes:
    expect(bytesOnDisk(finalPathFor(root, hex))).toEqual(text('CORRUPT OBJECT'));
  });

  it('reports missing content as a verdict / typed error — never empty bytes', async () => {
    const { store } = makeStore();
    const missingRef = `sha256:${'a'.repeat(64)}`;
    expect(await store.verify(missingRef)).toEqual({ status: 'missing' });
    await expect(store.get(missingRef)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { reason: 'CAS_CONTENT_MISSING' },
    });
  });
});

describe('CAS publication protocol', () => {
  it('publishes a complete verified object and leaves no staging leftovers', async () => {
    const { store, root } = makeStore();
    const content = text('staging protocol');
    const stored = await store.put(content);
    const hex = stored.contentRef.slice('sha256:'.length);
    expect(existsSync(join(root, 'staging'))).toBe(false);
    expect(bytesOnDisk(finalPathFor(root, hex))).toEqual(content);
  });

  it('reuses an existing valid published object without rewriting it', async () => {
    const { store, root } = makeStore();
    const content = text('reuse me');
    const first = await store.put(content);
    const finalPath = finalPathFor(root, first.contentHash);
    const before = bytesOnDisk(finalPath);
    const second = await store.put(content);
    expect(second.contentRef).toBe(first.contentRef);
    expect(bytesOnDisk(finalPath)).toEqual(before);
  });

  it('ignores staging leftovers on lookups and read paths', async () => {
    const { store, root } = makeStore();
    const stored = await store.put(text('legit'));
    mkdirSync(join(root, 'staging'), { recursive: true });
    writeFileSync(join(root, 'staging', 'bogus.staging'), text('bogus'));
    await expect(store.get(stored.contentRef)).resolves.toEqual(text('legit'));
    expect(await store.verify(`sha256:${'b'.repeat(64)}`)).toEqual({ status: 'missing' });
  });

  it('handles concurrent same-content writers: one object, identical results, no partial state', async () => {
    const { store, root } = makeStore();
    const content = text('concurrent identical writers');
    const results = await Promise.all(Array.from({ length: 10 }, () => store.put(content)));
    expect(new Set(results.map((r) => r.contentRef)).size).toBe(1);
    expect(results.every((r) => r.sizeBytes === content.byteLength)).toBe(true);
    const hex = results[0]!.contentRef.slice('sha256:'.length);
    expect(bytesOnDisk(finalPathFor(root, hex))).toEqual(content);
    expect(existsSync(join(root, 'staging'))).toBe(false);
    await expect(store.get(results[0]!.contentRef)).resolves.toEqual(content);
  });

  it('handles concurrent different-content writers without cross-contamination', async () => {
    const { store } = makeStore();
    const contents = Array.from({ length: 6 }, (_, i) => text(`writer ${i} payload`));
    const results = await Promise.all(contents.map((c) => store.put(c)));
    expect(new Set(results.map((r) => r.contentRef)).size).toBe(6);
    for (let i = 0; i < contents.length; i += 1) {
      await expect(store.get(results[i]!.contentRef)).resolves.toEqual(contents[i]!);
    }
  });
});

describe('CAS ref parsing and path-injection protection', () => {
  it.each([
    'sha256:',
    'sha256:abc',
    'sha256:' + 'A'.repeat(64),
    'sha256:' + 'g'.repeat(64),
    'sha256:' + 'a'.repeat(63),
    'sha256:' + 'a'.repeat(65),
    '../etc/passwd',
    '..\\windows\\system32',
    'C:\\Windows\\System32\\config',
    'file:///C:/Windows',
    '\\\\server\\share\\payload',
    'workspace/foo/bar.md',
    'cas:sha256:' + 'a'.repeat(64),
    'random-string',
    '',
  ])('refuses %j as a non-canonical managed ref', async (bad) => {
    const { store } = makeStore();
    await expect(store.get(bad as string)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'ARTIFACT_CONTENT_REF_INVALID' },
    });
    await expect(store.verify(bad as string)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('never resolves a managed ref outside the trusted root (digest-derived paths only)', async () => {
    const { store, root } = makeStore();
    // Dot segments cannot survive the strict hex validation:
    await expect(store.get(`sha256:${'..'.repeat(32)}`)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'ARTIFACT_CONTENT_REF_INVALID' },
    });
    // A valid hex ref maps ONLY to <root>/<2 hex>/<64 hex>:
    const stored = await store.put(text('inside root'));
    const hex = stored.contentRef.slice('sha256:'.length);
    expect(bytesOnDisk(finalPathFor(root, hex))).toEqual(text('inside root'));
  });
});

describe('CAS publication corrective (review: hard-link, no copy fallback)', () => {
  const correctStagingContent = text('published via hard link');

  it('crash window: final + leftover staging (same hard-linked content) read as valid', async () => {
    const { store, root } = makeStore();
    const hex = digestOf(correctStagingContent);
    // Simulate: staging written and hard-linked to final, but the staging unlink never ran.
    mkdirSync(join(root, 'staging'), { recursive: true });
    const stagingPath = join(root, 'staging', 'leftover.staging');
    writeFileSync(stagingPath, correctStagingContent);
    mkdirSync(join(root, hex.slice(0, 2)), { recursive: true });
    linkSync(stagingPath, finalPathFor(root, hex));

    // The published final object is complete and valid:
    const stored = await store.put(correctStagingContent);
    expect(stored.contentRef).toBe(`sha256:${hex}`);
    await expect(store.get(`sha256:${hex}`)).resolves.toEqual(correctStagingContent);
    expect(await store.verify(`sha256:${hex}`)).toEqual({ status: 'valid', sizeBytes: correctStagingContent.byteLength });
    // The staging leftover is NOT treated as corruption (cleanup belongs to Task-13-10):
    expect(existsSync(stagingPath)).toBe(true);
  });

  it('structural proof: publication is link-only — no copy-into-final path exists', () => {
    const source = readFileSync(join(process.cwd(), 'packages', 'persistence', 'src', 'content', 'cas-store.ts'), 'utf8');
    // The final namespace can only be created through linkSync of a completed staging
    // object; no "open final → stream/copy bytes into final" path may exist.
    expect(source).toContain('linkSync(stagingPath, finalPath)');
    expect(source).not.toContain('copyFileSync');
    expect(source).not.toContain("openSync(finalPath");
    // fsync failures fail the publication (no silent swallow):
    expect(source).toContain('CAS_FSYNC_FAILED');
  });
});
