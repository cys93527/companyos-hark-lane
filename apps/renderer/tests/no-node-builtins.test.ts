/**
 * Sprint 0 acceptance: the renderer bundle graph contains zero Node built-ins.
 * The renderer talks to the main process through the preload bridge only — an
 * accidental `node:fs` import would break `sandbox: true` at runtime.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const sourceFiles = walk(SRC_DIR).filter((file) => ['.ts', '.tsx'].includes(extname(file)));

describe('renderer import hygiene', () => {
  it('scans the renderer sources', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('imports no Node built-ins', () => {
    const offenders = sourceFiles.filter((file) => /from\s+['"]node:/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('imports no Electron and calls no CommonJS require', () => {
    const offenders = sourceFiles.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /from\s+['"]electron['"]/.test(source) || /\brequire\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
