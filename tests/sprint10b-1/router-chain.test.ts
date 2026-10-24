/**
 * Sprint 10B.1 §一 tests: the production composition root really enables the `router` chain, and
 * the resulting database really contains the `router_decisions` table.
 *
 * These assertions run against a REAL SQLite file opened through `openDurableDatabase`, with the
 * SAME chain list the desktop composition root requests (imported from the shared fixture).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase } from '@companyos/persistence';

import { EXPECTED_COMPOSITION_CHAINS, ROUTER_CHAIN_TABLE } from '../shared/expected-chains.js';

const tempDirs: string[] = [];

const makeDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-router-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('10B.1 §一: the router chain is production-enabled', () => {
  it('A: the shared fixture lists the router chain (single source of truth)', () => {
    expect([...EXPECTED_COMPOSITION_CHAINS]).toContain('router');
    expect(ROUTER_CHAIN_TABLE).toBe('router_decisions');
    // The fixture is the only place the chain order lives: the composition root has no literal list.
    // Sprint 11 appends the handoff chain after the router chain.
    expect(EXPECTED_COMPOSITION_CHAINS).toContain('router');
    expect(EXPECTED_COMPOSITION_CHAINS.indexOf('router')).toBeLessThan(
      EXPECTED_COMPOSITION_CHAINS.length,
    );
    expect(EXPECTED_COMPOSITION_CHAINS).toContain('handoff');
  });

  it('B: opening the production chain set really creates router_decisions', () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({
      dataDir,
      appliedAt: '2027-06-01T10:00:00.000Z',
      chains: [...EXPECTED_COMPOSITION_CHAINS],
    });
    try {
      // The migration chain ran…
      expect(db.migrations.router).not.toBeNull();
      expect(db.chains).toContain('router');
      // …and the table is physically there in the file.
      const raw = new DatabaseSync(db.path);
      try {
        const row = raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(ROUTER_CHAIN_TABLE) as { readonly name?: string } | undefined;
        expect(row?.name).toBe(ROUTER_CHAIN_TABLE);
        const columns = raw.prepare('PRAGMA table_info(router_decisions)').all() as unknown as readonly {
          readonly name: string;
        }[];
        const names = columns.map((column) => column.name);
        for (const column of [
          'decision_id',
          'request_id',
          'task_id',
          'role_id',
          'selection_mode',
          'selected_model_key',
          'decision',
          'reason_codes_json',
          'candidate_evaluations_json',
          'rejected_candidates_json',
          'policy_snapshot_version',
          'model_registry_revision',
          'benchmark_version',
          'performance_snapshot',
          'router_version',
          'trace_id',
          'created_at',
        ]) {
          expect(names, `router_decisions must have ${column}`).toContain(column);
        }
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });

  it('C: the chain is opt-in - a database opened without it has no router_decisions table', () => {
    const dataDir = makeDataDir();
    const db = openDurableDatabase({ dataDir, appliedAt: '2027-06-01T10:00:00.000Z', chains: ['core', 'engine'] });
    try {
      expect(db.migrations.router).toBeNull();
      const raw = new DatabaseSync(db.path);
      try {
        const row = raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(ROUTER_CHAIN_TABLE) as { readonly name?: string } | undefined;
        expect(row?.name).toBeUndefined();
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });
});
