/**
 * Sprint 6 boundary checks (P + secrets + schema):
 *   - no vendor name may appear in ANY shipped source (adapters are the only place that
 *     may know a vendor, and none exists yet);
 *   - no secret value may be committed, logged or persisted;
 *   - the secret table has no column able to hold a value;
 *   - Core/Engine stay free of HTTP clients and timers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { providerMigrationsDir, loadMigrations } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const sourceFiles = (dir: string): readonly string[] => {
  const walk = (current: string): readonly string[] =>
    readdirSync(current).flatMap((entry) => {
      const full = join(current, entry);
      return statSync(full).isDirectory()
        ? walk(full)
        : ['.ts', '.tsx', '.mjs', '.cjs', '.json'].includes(extname(full))
          ? [full]
          : [];
    });
  return walk(repo(dir));
};

const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

/** The vendor names this sprint forbids inside Core/Engine (and inside any source). */
const VENDOR_NAMES = ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama'];

describe('P. vendor independence', () => {
  it('no shipped source names a provider vendor', () => {
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles('packages/core/src'),
      ...sourceFiles('packages/engine/src'),
      ...sourceFiles('packages/persistence/src'),
      ...sourceFiles('packages/contracts/src'),
      ...sourceFiles('apps/desktop/src'),
      ...sourceFiles('apps/renderer/src'),
    ]) {
      const code = codeOnly(readFileSync(file, 'utf8')).toLowerCase();
      for (const vendor of VENDOR_NAMES) {
        if (new RegExp(`\\b${vendor}\\b`).test(code)) offenders.push(`${file}: ${vendor}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Core keeps no HTTP client and no timers', () => {
    const code = codeOnly(
      sourceFiles('packages/core/src')
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n'),
    );
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/node:https?/);
    expect(code).not.toMatch(/setTimeout|setInterval/);
    expect(code).not.toMatch(/axios|undici|got\b/);
  });

  it('the provider registry speaks only to Core ports (no IO of its own)', () => {
    const raw = readFileSync(repo('packages/engine/src/providers/registry.ts'), 'utf8');
    const code = codeOnly(raw);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/node:https?/);
    expect(code).not.toMatch(/setTimeout|setInterval/);
    const specifiers = [...raw.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect([...new Set(specifiers)]).toEqual(['@companyos/core']);
  });
});

describe('secrets never reach a durable or textual surface', () => {
  /** A credential-shaped literal: `sk-` followed by 16+ token characters. */
  const secretLike = /sk-[A-Za-z0-9_-]{16,}/g;

  it('no shipped or test file contains a real-looking credential', () => {
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles('packages'),
      ...sourceFiles('apps'),
      ...sourceFiles('tests'),
      ...sourceFiles('scripts'),
      ...sourceFiles('docs'),
    ]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.match(secretLike) ?? []) {
        // The only allowed hits are the clearly-labelled mock values used by tests.
        if (!match.startsWith('sk-mock-')) offenders.push(`${file}: ${match.slice(0, 10)}...`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the secret schema has no value column', () => {
    const migration = loadMigrations(providerMigrationsDir())[0];
    if (migration === undefined) throw new Error('provider migration missing');
    const sql = readFileSync(migration.path, 'utf8');
    const secretBlock = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS secret_refs'));
    const table = secretBlock.slice(0, secretBlock.indexOf(');'));
    expect(table).toContain('source');
    for (const forbidden of ['value', 'secret_value', 'api_key', 'token']) {
      expect(table).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // Roles + providers are in the same chain, and the chain is not the frozen ones.
    expect(loadMigrations(providerMigrationsDir()).map((entry) => entry.name)).toEqual([
      '0001_provider_registry',
    ]);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS roles');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS providers');
  });
});
