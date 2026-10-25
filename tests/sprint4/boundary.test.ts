/**
 * Sprint 4 boundary checks.
 *
 * The Sprint 3 boundary test already proves Core/Engine carry no SQL and that
 * persistence never depends on the engine; this one proves the NEW lifecycle code keeps
 * the same boundaries, and that the frozen Sprint 3 migration chain was not touched.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { engineMigrationsDir, lifecycleMigrationsDir, loadMigrations } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const sourceFiles = (dir: string): readonly string[] => {
  const walk = (current: string): readonly string[] =>
    readdirSync(current).flatMap((entry) => {
      const full = join(current, entry);
      return statSync(full).isDirectory() ? walk(full) : extname(full) === '.ts' ? [full] : [];
    });
  return walk(repo(dir));
};

const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

describe('the lifecycle layer keeps the architecture boundaries', () => {
  it('the lifecycle service talks only to Core contracts', () => {
    const raw = readFileSync(repo('packages/engine/src/lifecycle-service.ts'), 'utf8');
    const code = codeOnly(raw);
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/\bSELECT\b/);
    // Only Core, in both value and type positions.
    const specifiers = [...raw.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect([...new Set(specifiers)]).toEqual(['@companyos/core']);
  });

  it('no industry vocabulary leaked into the lifecycle code', () => {
    const source = [
      ...sourceFiles('packages/engine/src'),
      ...sourceFiles('packages/core/src/lifecycle'),
      ...sourceFiles('packages/persistence/src/durable'),
    ]
      .map((file) => codeOnly(readFileSync(file, 'utf8')))
      .join('\n');
    for (const forbidden of ['Coding', 'Git', 'Repository', 'Developer', 'CTO', 'Article', 'Video', 'Ecommerce']) {
      expect(new RegExp(`\\b${forbidden}\\b`).test(source), `${forbidden} must not appear`).toBe(false);
    }
  });

  it('ships the governance schema as a NEW checksum-protected chain', () => {
    // Historical entries remain; ADR-0032 adds only the approved Goal envelope.
    expect(loadMigrations(engineMigrationsDir()).map((migration) => migration.name)).toEqual([
      '0001_engine_persistence',
      '0002_task_run_ownership',
      '0003_execution_attempts',
      '0004_provider_dispatches',
      '0005_dispatch_config_fingerprint',
      '0006_provider_dispatch_routing_decision',
      '0007_execution_attempt_failure',
      '0008_goal_execution_budget',
      '0009_run_failure_reason_typed',
    ]);
    // …and the lifecycle tables live in their own chain.
    const lifecycle = loadMigrations(lifecycleMigrationsDir());
    expect(lifecycle.map((migration) => migration.name)).toEqual(['0001_workflow_lifecycle']);
    expect(lifecycle[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);

    const sql = readFileSync(lifecycle[0]!.path, 'utf8');
    for (const table of [
      'workflow_templates',
      'workflow_template_versions',
      'workflow_template_locks',
      'workflow_change_requests',
      'run_snapshots',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    // Requirement 14 is enforced by the database, not by application code alone.
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_locks_one_active[\s\S]*WHERE released_at IS NULL/);
    // Requirement M is enforced by a unique constraint.
    expect(sql).toMatch(/UNIQUE \(template_id, semver\)/);
  });

  it('still never makes persistence depend on the engine', () => {
    const manifest = JSON.parse(readFileSync(repo('packages/persistence/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@companyos/engine']).toBeUndefined();
    expect(manifest.peerDependencies?.['@companyos/engine']).toBeUndefined();
  });
});
