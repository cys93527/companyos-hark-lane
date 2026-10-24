/**
 * Engine boundary law (STEP 7 / AGENTS.md §1.3): the engine may depend on Core
 * contracts and ports ONLY, and must not know any industry or vendor vocabulary.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const engineRoot = (path: string): string =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

const sourceFiles = (): readonly string[] => {
  const dir = engineRoot('src');
  const walk = (current: string): readonly string[] =>
    readdirSync(current).flatMap((entry) => {
      const full = join(current, entry);
      return statSync(full).isDirectory() ? walk(full) : extname(full) === '.ts' ? [full] : [];
    });
  return walk(dir);
};

const readSource = (file: string): string => readFileSync(file, 'utf8');

/** Strip comments and string literals so only identifiers remain. */
const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

describe('engine boundary', () => {
  it('declares @companyos/core as its only runtime dependency', () => {
    const manifest = JSON.parse(readSource(engineRoot('package.json'))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ '@companyos/core': 'workspace:*' });
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it('imports nothing but Core and its own modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readSource(file);
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        const allowed =
          specifier === '@companyos/core' ||
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier.startsWith('node:');
        if (!allowed) offenders.push(`${file.replace(engineRoot(''), '')}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never names an industry noun as an identifier', () => {
    const forbidden = ['coding', 'git', 'repository', 'developer', 'cto', 'article', 'video', 'ecommerce'];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = codeOnly(readSource(file));
      for (const noun of forbidden) {
        if (new RegExp(`\\b${noun}\\b`, 'i').test(code)) {
          offenders.push(`${file.replace(engineRoot(''), '')}: ${noun}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never names a model vendor anywhere — including comments and strings', () => {
    const vendorLike = /openai|anthropic|deepseek|gemini|kimi|claude|gpt-|qwen|mistral|llama/i;
    const offenders = sourceFiles().filter((file) => vendorLike.test(readSource(file)));
    expect(offenders.map((file) => file.replace(engineRoot(''), ''))).toEqual([]);
  });

  it('has no transport, UI or scheduler capability', () => {
    const forbidden = /electron|react-dom|better-sqlite3|express|axios|node-fetch|setInterval|setTimeout|Math\.random|Date\.now/;
    const offenders = sourceFiles().filter((file) => forbidden.test(codeOnly(readSource(file))));
    expect(offenders.map((file) => file.replace(engineRoot(''), ''))).toEqual([]);
  });
});
