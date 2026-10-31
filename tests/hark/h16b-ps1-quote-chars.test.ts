import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/*
 * H16b-3b-fix3 (hark-installer 41189442900): configure-isolation.ps1 failed to PARSE on Windows PowerShell 5.1
 * ("Unexpected token '已隔离”：'") because PowerShell treats the typographic quotes U+2018..U+201E as ordinary quote
 * delimiters — a Chinese “…” inside a "…" string closes the string. Every shipped PowerShell script (scripts/hark/**)
 * must therefore contain none of them (use 「…」 for quotation in Chinese text), and any script with non-ASCII text
 * must start with a UTF-8 BOM, otherwise PowerShell 5.1 decodes it with the ANSI code page.
 */
const root = join(__dirname, '..', '..', 'scripts', 'hark');

function ps1Files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...ps1Files(p));
    else if (/\.ps(m?1|d1)$/i.test(name)) out.push(p);
  }
  return out;
}

const files = ps1Files(root);

describe('H16b shipped PowerShell scripts parse on Windows PowerShell 5.1', () => {
  it('finds the shipped scripts', () => {
    const rel = files.map((f) => relative(root, f).replace(/\\/g, '/'));
    expect(rel).toContain('setup/configure-isolation.ps1');
    expect(rel).toContain('setup/configure-deepseek.ps1');
    expect(rel).toContain('isolation/setup.ps1');
  });

  it.each(files.map((f) => [relative(root, f), f]))('%s has no typographic quote characters', (_rel, f) => {
    const text = readFileSync(f, 'utf8');
    const hits = text
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter((l) => /[\u2018-\u201E]/.test(l.text));
    expect(hits).toEqual([]);
  });

  it.each(files.map((f) => [relative(root, f), f]))('%s starts with a UTF-8 BOM when it contains non-ASCII text', (_rel, f) => {
    const bytes = readFileSync(f);
    const nonAscii = bytes.some((b) => b > 0x7f);
    if (nonAscii) expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
