/**
 * Sprint 7 tests P/Q: the Registry UI never touches persistence, and neither the new code
 * nor the new UI introduces a vendor name or an implicit model choice.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { registryMigrationsDir, loadMigrations } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const sourceFiles = (dir: string): readonly string[] => {
  const walk = (current: string): readonly string[] =>
    readdirSync(current).flatMap((entry) => {
      const full = join(current, entry);
      return statSync(full).isDirectory()
        ? walk(full)
        : ['.ts', '.tsx'].includes(extname(full))
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

describe('P. the Registry UI shares the single IPC door', () => {
  it('never imports persistence, the engine internals or SQLite', () => {
    const code = codeOnly(readFileSync(repo('apps/renderer/src/registry.tsx'), 'utf8'));
    expect(code).not.toMatch(/@companyos\/persistence/);
    expect(code).not.toMatch(/@companyos\/engine/);
    expect(code).not.toMatch(/@companyos\/core/);
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/\bSELECT\b/);
    expect(code).not.toMatch(/\bfetch\(/);
  });

  it('talks only through workflowRequest operations', () => {
    const raw = readFileSync(repo('apps/renderer/src/registry.tsx'), 'utf8');
    const operations = [...raw.matchAll(/operation:\s*'([^']+)'/g)]
      .map((match) => match[1] ?? '')
      .filter((operation) => operation.length > 0);
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(operation.startsWith('models.')).toBe(true);
    expect(raw).toMatch(/workflowRequest\(/);
  });

  it('renders no recommendation or scoring affordance', () => {
    const raw = readFileSync(repo('apps/renderer/src/registry.tsx'), 'utf8');
    const code = codeOnly(raw);
    // Declarations and calls only: a JSX sentence may *say* there is no fallback, but no
    // identifier may implement one.
    expect(code).not.toMatch(
      /export\s+(?:function|const|async\s+function)\s+(?:recommend|score|rank|fallback|pickBest|autoSelect)\w*/i,
    );
    expect(code).not.toMatch(/\b(?:recommendedModel|modelScore|routingFallback|pickBestModel)\b/i);
    // …and the UI says out loud that there is no automatic selection.
    expect(raw).toMatch(/no automatic selection|no fallback|exactly one model/i);
  });

  it('the desktop layer routes model operations through the registry service (no SQL)', () => {
    const code = codeOnly(readFileSync(repo('apps/desktop/src/workflows.ts'), 'utf8'));
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/\bSELECT\b/);
    expect(code).toMatch(/deps\.models\./);
  });
});

describe('Q. no vendor name, no implicit choice', () => {
  it('the new registry code names no provider vendor', () => {
    const vendors = ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama'];
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles('packages/core/src'),
      ...sourceFiles('packages/engine/src'),
      ...sourceFiles('packages/persistence/src'),
      ...sourceFiles('apps/desktop/src'),
      ...sourceFiles('apps/renderer/src'),
    ]) {
      const code = codeOnly(readFileSync(file, 'utf8')).toLowerCase();
      for (const vendor of vendors) {
        if (new RegExp(`\\b${vendor}\\b`).test(code)) offenders.push(`${file}: ${vendor}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('neither Core nor the registry contains ranking or fallback logic', () => {
    const registry = codeOnly(readFileSync(repo('packages/engine/src/registry/model-registry.ts'), 'utf8'));
    for (const forbidden of ['score', 'rank', 'fallback', 'pickBest', 'cheapest', 'sortByScore']) {
      expect(registry).not.toMatch(new RegExp(forbidden, 'i'));
    }
    const core = codeOnly(readFileSync(repo('packages/core/src/domain/model-registry.ts'), 'utf8'));
    for (const forbidden of ['score', 'rank', 'fallback', 'pickBest', 'cheapest']) {
      expect(core).not.toMatch(new RegExp(forbidden, 'i'));
    }
  });

  it('ships the registry schema as its own checksum-protected chain', () => {
    const migrations = loadMigrations(registryMigrationsDir());
    expect(migrations.map((entry) => entry.name)).toEqual(['0001_model_registry']);
    const sql = readFileSync(migrations[0]!.path, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS model_records');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS logical_aliases');
    // A registry has no routing column: no score, no priority, no fallback order.
    const ddl = sql.replace(/--.*$/gm, ' ');
    expect(ddl).not.toMatch(/\bscore\b/i);
    expect(ddl).not.toMatch(/\bpriority\b/i);
    expect(ddl).not.toMatch(/\bfallback\b/i);
    // Provider + lifecycle chains are untouched by this sprint.
    expect(loadMigrations(registryMigrationsDir()).length).toBe(1);
  });
});
