/**
 * LIVE-CONTRACT-FILL UI defect (b), main-process side: goal.workspace reads back the latest
 * failed execution attempt with the provider's typed reason (from its durable
 * executor.dispatch_settled row), so the renderer can say WHY a goal failed.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createLatestAttemptFailureReader } from '../../apps/desktop/src/goal-attempt-failure.js';

const db = () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE execution_attempts (id TEXT, run_id TEXT, task_id TEXT, state TEXT, failure_code TEXT, created_at TEXT, settled_at TEXT);
          CREATE TABLE events (aggregate_id TEXT, type TEXT, payload TEXT);`);
  return d;
};

describe('latest failed attempt with its typed reason', () => {
  it('returns the newest FAILED attempt and the reasonCode of its settled row', async () => {
    const d = db();
    const add = d.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)');
    add.run('exa_1', 'run_exec', 'tsk_1', 'FAILED', 'PROVIDER_FAILED', '2026-11-05T17:33:00Z', '2026-11-05T17:34:00Z');
    add.run('exa_2', 'run_exec', 'tsk_1', 'FAILED', 'PROVIDER_FAILED', '2026-11-05T17:34:10Z', '2026-11-05T17:36:00Z');
    add.run('exa_x', 'run_other', 'tsk_9', 'FAILED', 'PROVIDER_FAILED', '2026-11-05T18:00:00Z', '2026-11-05T18:01:00Z');
    d.prepare('INSERT INTO events VALUES (?, ?, ?)').run('exa_2', 'executor.dispatch_settled', JSON.stringify({ outcome: 'provider-failed', reasonCode: 'EXECUTOR_KERNEL_OUTPUT_CEILING' }));
    const read = createLatestAttemptFailureReader(d as never);
    expect(await read(['run_goal', 'run_exec'])).toEqual({
      runId: 'run_exec', taskId: 'tsk_1', attemptId: 'exa_2', failureCode: 'PROVIDER_FAILED', detailCode: 'EXECUTOR_KERNEL_OUTPUT_CEILING', settledAt: '2026-11-05T17:36:00Z',
    });
  });
  it('no failed attempt -> null; a settled row without a well-formed code -> detail null', async () => {
    const d = db();
    const read = createLatestAttemptFailureReader(d as never);
    expect(await read(['run_exec'])).toBeNull();
    expect(await read([])).toBeNull();
    d.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run('exa_1', 'run_exec', 'tsk_1', 'FAILED', 'PROVIDER_FAILED', 'a', 'b');
    d.prepare('INSERT INTO events VALUES (?, ?, ?)').run('exa_1', 'executor.dispatch_settled', JSON.stringify({ reasonCode: 'not a code <script>' }));
    expect((await read(['run_exec']))?.detailCode).toBeNull();
  });
  it('is wired into goal.workspace (attemptFailure) by the production composition', () => {
    const core = readFileSync(new URL('../../apps/desktop/src/core-services.ts', import.meta.url), 'utf8');
    const plane = readFileSync(new URL('../../apps/desktop/src/control-plane.ts', import.meta.url), 'utf8');
    expect(core).toContain('latestAttemptFailure: createLatestAttemptFailureReader(database.db)');
    expect(plane).toMatch(/attemptFailure:\s*\n?\s*deps\.latestAttemptFailure === undefined/u);
  });
});
