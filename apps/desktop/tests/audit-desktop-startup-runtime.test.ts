/**
 * AUDIT-D8: the boot and the lazy retry share ONE startup sequence. Before the fix the lazy path
 * opened a new database handle per IPC call (leaked), composed with a null CAS foundation (never
 * succeeded), never cleared the failure and skipped recovery/autonomy on a later success.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRuntimeStarter, type RuntimeStarterSteps } from '../src/startup-runtime.js';

interface Db { readonly id: number; closed: boolean }

const harness = (over: Partial<RuntimeStarterSteps<Db, string, string>> & { dbFailures?: number; composeFailures?: number } = {}) => {
  const calls: string[] = [];
  const opened: Db[] = [];
  let dbFailures = over.dbFailures ?? 0;
  let composeFailures = over.composeFailures ?? 0;
  const steps: RuntimeStarterSteps<Db, string, string> = {
    openDatabase: () => {
      calls.push('openDatabase');
      if (dbFailures > 0) { dbFailures -= 1; return null; }
      const db = { id: opened.length + 1, closed: false };
      opened.push(db);
      return db;
    },
    databaseRetryable: () => true,
    openFoundation: async () => { calls.push('openFoundation'); return { ok: true, value: 'cas' }; },
    compose: async (_db, foundation) => {
      calls.push(`compose:${foundation}`);
      if (composeFailures > 0) { composeFailures -= 1; return null; }
      return 'core';
    },
    recover: async () => { calls.push('recover'); return { kind: 'ok' }; },
    commit: () => { calls.push('commit'); },
    startAutonomy: async () => { calls.push('startAutonomy'); },
    rehydrate: async () => { calls.push('rehydrate'); },
    closeDatabase: (db) => { calls.push('close'); db.closed = true; },
    ...over,
  };
  return { starter: createRuntimeStarter(steps), calls, opened };
};

describe('AUDIT-D8 one startup sequence for boot and retry', () => {
  it('a database that failed at boot succeeds on retry with the FULL sequence (CAS, recovery, autonomy, rehydrate)', async () => {
    const { starter, calls, opened } = harness({ dbFailures: 1 });
    expect((await starter.start()).kind).toBe('unavailable');
    const second = await starter.start();
    expect(second.kind).toBe('ready');
    expect(calls).toEqual(['openDatabase', 'openDatabase', 'openFoundation', 'compose:cas', 'recover', 'commit', 'startAutonomy', 'rehydrate']);
    expect(opened).toHaveLength(1);
  });

  it('a composition failure retries only the post-database steps and never opens a second handle', async () => {
    const { starter, calls, opened } = harness({ composeFailures: 2 });
    expect((await starter.start()).kind).toBe('unavailable');
    expect((await starter.start()).kind).toBe('unavailable');
    expect((await starter.start()).kind).toBe('ready');
    expect(opened).toHaveLength(1);
    expect(calls.filter((c) => c === 'openDatabase')).toHaveLength(1);
    expect(calls.filter((c) => c === 'openFoundation')).toHaveLength(1);
    expect(calls.filter((c) => c === 'recover')).toHaveLength(1);
    expect(calls.indexOf('commit')).toBeGreaterThan(calls.indexOf('recover'));
  });

  it('once ready, later calls reuse the instance (no recomposition, no second recovery)', async () => {
    const { starter, calls } = harness();
    await starter.start();
    const before = calls.length;
    expect((await starter.start()).kind).toBe('ready');
    expect(calls.length).toBe(before);
  });

  it('concurrent callers share one attempt', async () => {
    const { starter, calls } = harness();
    const [a, b] = await Promise.all([starter.start(), starter.start()]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c === 'compose:cas')).toHaveLength(1);
  });

  it('a fatal recovery closes the handle, commits nothing and is sticky', async () => {
    const { starter, calls, opened } = harness({ recover: async () => ({ kind: 'fatal', code: 'PERSISTENCE_FAILED', message: 'x' }) });
    const first = await starter.start();
    expect(first).toMatchObject({ kind: 'fatal', stage: 'recovery' });
    expect(opened[0]?.closed).toBe(true);
    expect(calls).not.toContain('commit');
    expect(calls).not.toContain('startAutonomy');
    expect(await starter.start()).toBe(first);
    expect(opened).toHaveLength(1);
  });

  it('a fatal CAS finding closes the handle and never composes', async () => {
    const { starter, calls, opened } = harness({ openFoundation: async () => ({ ok: false, code: 'CAS_HASH_MISMATCH', message: 'bad' }) });
    expect(await starter.start()).toMatchObject({ kind: 'fatal', stage: 'artifact-integrity', code: 'CAS_HASH_MISMATCH' });
    expect(opened[0]?.closed).toBe(true);
    expect(calls.some((c) => c.startsWith('compose'))).toBe(false);
  });

  it('a non-retryable database refusal is never re-opened', async () => {
    const { starter, calls } = harness({ dbFailures: 5, databaseRetryable: () => false });
    await starter.start();
    await starter.start();
    expect(calls.filter((c) => c === 'openDatabase')).toHaveLength(1);
  });

  it('main.ts drives both the boot and the lazy workflow path through the one starter', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('const runtimeStarter = createRuntimeStarter<');
    expect(main.match(/runtimeStarter\.start\(\)/g)?.length).toBe(2);
    expect(main.match(/composeCoreServices\(/g)?.length).toBe(2); // definition + the one step
    expect(main).not.toMatch(/shellDatabase \?\? \(isDatabaseBootstrapRetryable/);
    // the database failure is cleared once the database opens
    expect(main).toMatch(/databaseFailure = null;/);
  });
});
