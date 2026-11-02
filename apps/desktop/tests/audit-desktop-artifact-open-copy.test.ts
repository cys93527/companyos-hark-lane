/**
 * AUDIT-D4: Open/Reveal handed the canonical CAS object to the OS; one save in an external editor broke the
 * hash and the next launch failed CAS integrity. They now use a hash-verified read-only copy.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { exportArtifactCopy, exportExtension, type ArtifactTarget } from '../src/artifacts.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });
const bytesOf = (t: string): Uint8Array => new TextEncoder().encode(t);
const target = (content: Uint8Array, kind = 'text/markdown', id = 'art_1'): ArtifactTarget => {
  const hash = createHash('sha256').update(content).digest('hex');
  return { artifactId: id, kind, contentRef: `sha256:${hash}`, contentHash: hash, sizeBytes: content.byteLength, absolutePath: '/cas/xx/' + hash };
};
const store = (content: Uint8Array | null) => ({ get: async () => content }) as never;

describe('AUDIT-D4 open/reveal use a read-only copy', () => {
  it('writes a verified read-only copy outside the CAS and reuses it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companyos-d4-')); dirs.push(root);
    const content = bytesOf('# 报告\n');
    const t = target(content);
    const r = await exportArtifactCopy(t, store(content), root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe(join(root, 'art_1.md'));
    expect(r.value.path).not.toBe(t.absolutePath);
    expect(readFileSync(r.value.path, 'utf8')).toBe('# 报告\n');
    if (process.platform !== 'win32') expect(statSync(r.value.path).mode & 0o222).toBe(0);
    // the user edits the copy: the next open restores canonical bytes, canonical truth untouched
    chmodSync(r.value.path, 0o644); writeFileSync(r.value.path, 'edited');
    const again = await exportArtifactCopy(t, store(content), root);
    expect(again.ok && readFileSync(again.value.path, 'utf8')).toBe('# 报告\n');
  });

  it('refuses content whose hash does not match, missing content and unsafe ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companyos-d4-')); dirs.push(root);
    const t = target(bytesOf('a'));
    expect(await exportArtifactCopy(t, store(bytesOf('b')), root)).toMatchObject({ ok: false, code: 'ARTIFACT_CONTENT_HASH_MISMATCH' });
    expect(await exportArtifactCopy(t, store(null), root)).toMatchObject({ ok: false, code: 'ARTIFACT_CONTENT_MISSING' });
    expect(await exportArtifactCopy({ ...t, artifactId: '..\\x' }, store(bytesOf('a')), root)).toMatchObject({ ok: false, code: 'ARTIFACT_ID_INVALID' });
  });

  it('extension by kind, else sniffed', () => {
    expect(exportExtension('text/csv', bytesOf('a,b'))).toBe('.csv');
    expect(exportExtension('x/unknown', bytesOf('{"a":1}'))).toBe('.json');
    expect(exportExtension('x/unknown', bytesOf('hello'))).toBe('.txt');
    expect(exportExtension('x/unknown', new Uint8Array([0xff, 0xfe, 0x00]))).toBe('.bin');
  });

  it('main.ts never passes the CAS path to the OS and shows a dialog before a fatal exit', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).not.toContain('shell.openPath(target.value.absolutePath)');
    expect(main).not.toContain('shell.showItemInFolder(target.value.absolutePath)');
    expect(main).toContain("exportArtifactCopy(target.value, artifactFoundation.contentStore, join(tmpdir(), 'companyos-open'))");
    const exits = main.split('app.exit(1)').length - 1;
    expect(exits).toBe(2);
    for (const chunk of main.split('app.exit(1)').slice(0, -1)) expect(chunk.slice(-400)).toContain('dialog.showErrorBox(');
  });
});
