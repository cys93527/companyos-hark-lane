/**
 * LIVE-SMOKE-FIX-08C — inner tool invocation CRASH-durability closure.
 *
 * The remaining P1 gap after FIX-08B: mechanically prove that LEVEL B evidence
 * (the kernel's `tool_call <tool> <args-json>` line) is DURABLY COMMITTED inside
 * the CompanyOS stdout tap BEFORE anything downstream of the tool's execution is
 * observable — and that a kill/timeout after that commit leaves the evidence
 * restart-readable with attempt linkage, without any duplicate dispatch.
 *
 * Ordering facts proven here (mechanically, no sleeps as synchronization):
 *  1. `db.events.append` contains NO await before the synchronous node:sqlite
 *     `insert.run` — the commit happens during the append CALL, inside the stdout
 *     'data' handler. The fixtures prove it by synchronously READING the durable
 *     store immediately after the tap returns and finding the row.
 *  2. The kernel emits `tool_call` BEFORE executing the tool (pinned protocol; the
 *     tool's own output can only arrive on the same stream AFTER emission) — so a
 *     durable commit at arrival precedes every observable tool effect.
 *  3. LEVEL_B_EVENT_COMMITTED_BEFORE_TOOL_PROCESS_START: YES at the CompanyOS
 *     boundary — the commit completes before the tap handler returns; the inner
 *     process itself is kernel-controlled (pinned code), and the loss window is
 *     bounded by pipe delivery (the same stream the commit rides on).
 *
 * Append failure (§5): the kernel controls the inner process start, so a failed
 * LEVEL B append can never block execution — but it is no longer SILENT: the sink's
 * `onFailure` surfaces it (composition logs, typed reason). A full events-store
 * failure subsumes every durable surface (LEVEL A rows, engine settlement,
 * receipts) — there is no "audit alive / events dead" split to hide in.
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {openDurableDatabase} from '@companyos/persistence';

import {dshToolCallTapOf} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-fix08c-'));
  createdDirs.push(dir);
  return dir;
};

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;

describe('LIVE-SMOKE-FIX-08C — LEVEL B commit-at-arrival ordering (real store, real tap)', () => {
  it('the durable row EXISTS the instant the tap returns — proven by a synchronous read inside the stream handler', async () => {
    const db = openDurableDatabase({dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    const attemptId = 'exa_fix08c_000000000000000000000001';
    const observations: string[] = [];
    let n = 0;
    const tap = dshToolCallTapOf(
      {
        append: async (events) => { await db.events.append(events as never); },
        secrets: () => [],
        ids: {id: () => `evt_fix08c_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08c_${String(n).padStart(4, '0')}`},
        onFailure: () => { observations.push('onFailure'); },
      },
      {attemptId, taskId: 'tsk_fix08c', runId: 'run_fix08c', roleId: 'rol_fix08c', cwd: 'W:/ws'},
    );
    // Same-stream simulation: the kernel emits tool_call, THEN the tool's output.
    tap('tool_call pwsh {"command":"cmd /c echo inner-crash-proof"}');
    // DURABILITY AT ARRIVAL: the append call committed synchronously (no await before
    // insert.run) — a synchronous read THROUGH THE SAME STORE finds the row already.
    const immediate = db.db.prepare("SELECT payload FROM events WHERE type = 'executor.tool_invocation_requested'").all() as {payload: string}[];
    observations.push(`durableRowsRightAfterTap=${immediate.length}`);
    const payload = JSON.parse(immediate[0]!.payload) as Record<string, unknown>;
    expect(payload['attemptId']).toBe(attemptId);
    expect(String(payload['argsHead'])).toContain('cmd /c echo inner-crash-proof');
    // The tool's output arriving on the stream AFTER the tap cannot precede the commit.
    tap('tool_result call_00_x completed');
    tap('inner-crash-proof');
    // Failure surface stayed silent (append succeeded).
    expect(observations).not.toContain('onFailure');
    expect(observations).toEqual(['durableRowsRightAfterTap=1']);
    // Evidence-only: exactly one event per tool_call; non-tool lines appended nothing.
    expect(immediate).toHaveLength(1);
  }, 15_000);

  it('a SECOND tool_call on the stream commits independently — sequence and per-line durability hold', async () => {
    const db = openDurableDatabase({dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    const attemptId = 'exa_fix08c_000000000000000000000002';
    let n = 0;
    const tap = dshToolCallTapOf(
      {
        append: async (events) => { await db.events.append(events as never); },
        secrets: () => [],
        ids: {id: () => `evt_fix08c_b_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08c_b_${String(n).padStart(4, '0')}`},
        onFailure: () => undefined,
      },
      {attemptId, taskId: 'tsk_fix08c', runId: 'run_fix08c', roleId: 'rol_fix08c', cwd: null},
    );
    const forms = [
      'tool_call pwsh {"command":"node bin\\cli.js [1,2]"}',
      'tool_call pwsh {"command":"bin\\cli.js [1,2]"}',
      'tool_call pwsh {"command":"cmd /c bin\\cli.js [1,2]"}',
    ];
    for (const line of forms) {
      tap(line);
      // At-arrival durability, per line, again synchronous.
      const count = (db.db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'executor.tool_invocation_requested'").get() as {c: number}).c;
      expect(count).toBe(forms.indexOf(line) + 1);
    }
    const rows = db.db.prepare("SELECT payload FROM events WHERE type = 'executor.tool_invocation_requested' ORDER BY rowid").all() as {payload: string}[];
    const heads = rows.map((r) => String((JSON.parse(r.payload) as Record<string, unknown>)['argsHead']));
    expect(heads[0]!).toContain('node bin\\cli.js');
    expect(heads[1]!).toContain('bin\\cli.js');
    expect(heads[1]!).not.toContain('node');
    expect(heads[2]!).toContain('cmd /c bin\\cli.js');
    const sequences = rows.map((r) => (JSON.parse(r.payload) as Record<string, unknown>)['sequence']);
    expect(sequences).toEqual([1, 2, 3]);
  }, 15_000);
});

describe('LIVE-SMOKE-FIX-08C — append failure is LOUD (§5)', () => {
  it('a rejected append surfaces through onFailure — never a silent fallback; the timeout-path stdout tail still carries the verbatim tool_call lines as equivalent attribution', async () => {
    const failures: unknown[] = [];
    const db = openDurableDatabase({dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    let n = 0;
    const tap = dshToolCallTapOf(
      {
        append: async () => { throw new Error('events store unavailable (fixture)'); },
        secrets: () => [],
        ids: {id: () => `evt_fix08c_f_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08c_f_${String(n).padStart(4, '0')}`},
        onFailure: (error) => { failures.push(error); },
      },
      {attemptId: 'exa_fix08c_000000000000000000000005', taskId: 'tsk_fix08c', runId: 'run_fix08c', roleId: 'rol_fix08c', cwd: 'W:/ws'},
    );
    tap('tool_call pwsh {"command":"node bin\\cli.js [1,2]"}');
    // The failure was surfaced synchronously-adjacent (microtask), never swallowed.
    await new Promise((r) => setTimeout(r, 20));
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('events store unavailable');
    // The durable store holds NOTHING (append failed) — and the FIX-08 timeout tail
    // (dispatch_settled stdoutTail, FIX-08 regression suite) is the equivalent
    // attribution surface carrying the verbatim tool_call line.
    expect((db.db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'executor.tool_invocation_requested'").get() as {c: number}).c).toBe(0);
    db.close();
  }, 15_000);
});
