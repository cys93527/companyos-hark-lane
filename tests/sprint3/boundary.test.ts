/**
 * Sprint 3 requirement 15 — the persistence work must not leak into Core or the Engine.
 *
 * What is asserted here:
 *   1. Core source knows nothing about SQLite and nothing about persistence packages;
 *   2. Engine source knows nothing about SQLite and imports only Core;
 *   3. `@companyos/persistence` does NOT depend on `@companyos/engine`;
 *   4. the durable stores implement the Core ports (compile-time + runtime proof);
 *   5. SQL text exists only in the outer-ring persistence package.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  Approval,
  CommandLedgerPort,
  EntityStore,
  EventStorePort,
  Task,
  UnitOfWork,
  WorkflowRun,
} from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const sourceFiles = (dir: string): readonly string[] => {
  const walk = (current: string): readonly string[] =>
    readdirSync(current).flatMap((entry) => {
      const full = join(current, entry);
      return statSync(full).isDirectory() ? walk(full) : extname(full) === '.ts' ? [full] : [];
    });
  return walk(repo(dir));
};

const readAll = (dir: string): string =>
  sourceFiles(dir)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Strip comments and string literals so only code (identifiers, SQL) remains. */
const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

describe('persistence does not leak into Core or the Engine', () => {
  it('Core source has no SQLite driver and no SQL', () => {
    const raw = readAll('packages/core/src');
    const code = codeOnly(raw);
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/\bSELECT\b/);
    // No actual import of an outer-ring implementation (prose in comments is fine).
    expect(raw).not.toMatch(/from\s+'@companyos\/(persistence|engine|observability|desktop|renderer)'/);
    expect(raw).not.toMatch(/require\('@companyos\//);
  });

  it('Engine source has no SQLite driver, no SQL and no persistence import', () => {
    const raw = readAll('packages/engine/src');
    const code = codeOnly(raw);
    expect(code).not.toMatch(/node:sqlite/);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/\bSELECT\b/);
    expect(raw).not.toMatch(/from\s+'@companyos\/persistence'/);
    expect(raw).not.toMatch(/require\('@companyos\/persistence'\)/);
  });

  it('Engine package depends on Core only', () => {
    const manifest = JSON.parse(readFileSync(repo('packages/engine/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ '@companyos/core': 'workspace:*' });
  });

  it('Persistence never depends on the Engine', () => {
    const manifest = JSON.parse(readFileSync(repo('packages/persistence/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@companyos/engine']).toBeUndefined();
    expect(manifest.peerDependencies?.['@companyos/engine']).toBeUndefined();
  });

  it('the durable SQL lives only in the persistence outer ring', () => {
    const sql = readAll('packages/persistence/src/durable');
    expect(sql).toMatch(/SELECT/);
    // …and the schema itself is a checksum-protected migration file, not inline DDL.
    const migration = readFileSync(
      repo('packages/persistence/migrations/engine/0001_engine_persistence.sql'),
      'utf8',
    );
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS runs/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS command_ledger/);
  });});

describe('the durable layer implements the Core ports', () => {
  it('satisfies every port contract (typed, not duck-typed by accident)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companyos-sprint3-boundary-'));
    created.push(dir);
    const database: DurableDatabase = openDurableDatabase({
      dataDir: dir,
      appliedAt: '2026-05-01T00:00:00.000Z',
    });

    // Compile-time proof: each store is assignable to the Core port type.
    const runs: EntityStore<WorkflowRun> = database.runs;
    const tasks: EntityStore<Task> = database.tasks;
    const approvals: EntityStore<Approval> = database.approvals;
    const events: EventStorePort = database.events;
    const ledger: CommandLedgerPort = database.ledger;
    const unitOfWork: UnitOfWork = database.unitOfWork;

    // Runtime proof: the functions the engine actually calls exist.
    for (const store of [runs, tasks, approvals]) {
      expect(typeof store.get).toBe('function');
      expect(typeof store.put).toBe('function');
      expect(typeof store.delete).toBe('function');
      expect(typeof store.list).toBe('function');
    }
    expect(typeof events.append).toBe('function');
    expect(typeof events.readFrom).toBe('function');
    expect(typeof events.lastPosition).toBe('function');
    expect(typeof events.readByAggregate).toBe('function');
    expect(typeof ledger.get).toBe('function');
    expect(typeof ledger.put).toBe('function');
    expect(typeof ledger.count).toBe('function');
    expect(typeof ledger.trim).toBe('function');
    expect(typeof unitOfWork.transaction).toBe('function');

    const committed = await unitOfWork.transaction(async () => 'ok');
    expect(committed).toEqual({ ok: true, value: 'ok' });
    expect(await events.lastPosition()).toBe(0);
    expect(await ledger.count()).toBe(0);

    database.close();
  });
});
