/**
 * Sprint 13 / Task-13-06 corrective (ADR-0018): durable tool invocation replay output.
 *
 * Generic Tool-Registry-level guarantees (§25): success replay restores the ORIGINAL
 * output with the adapter called exactly once; a tampered snapshot fails closed against
 * the recorded digest; a legacy COMPLETED row without a snapshot fails closed instead
 * of pretending output:null is a valid replay; a different idempotency key executes a
 * fresh invocation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createToolRecord,
  ok,
  type DomainError,
  type ToolPort,
  type ToolRegistryPort,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';
import { createToolRegistry } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const clock = { now: (): number => Date.parse('2026-01-01T00:00:00.000Z'), nowIso: (): string => '2026-01-01T00:00:00.000Z' };
const ids = (() => {
  let n = 0;
  return { id: (prefix = 'id') => `${prefix}_01JT17${String(++n).padStart(4, '0')}`, ulid: () => `01JT17${String(++n).padStart(20, '0')}` };
})();
const ACTOR = 'user_owner';
const allow = async (): Promise<{ readonly ok: true; readonly value: true }> => ok(true);

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const OUTPUT = { verdict: 'pass', evidenceRefs: ['command:gen'], nested: { b: 2, a: [1, 2] } };

/** Counting adapter returning the scripted output. */
let adapterCalls = 0;
const adapter: ToolPort = {
  describe: () => ({
    toolId: 'gen.tool', name: 'gen', description: 'gen', version: '1.0.0', riskLevel: 'LOW',
    parameters: {}, capabilities: [], inputSchema: {}, outputSchema: {},
  }),
  invoke: async (_request: ToolRequest): Promise<{ ok: true; value: ToolResult } | { ok: false; error: DomainError }> => {
    adapterCalls += 1;
    return {
      ok: true,
      value: { status: 'ok', output: structuredClone(OUTPUT), artifactRefs: [], startedAt: clock.nowIso(), finishedAt: clock.nowIso(), latencyMs: 1 },
    };
  },
};

interface Harness {
  readonly registry: ToolRegistryPort;
  readonly db: DurableDatabase;
}

const make = (): Harness => {
  adapterCalls = 0;
  const db = openDurableDatabase({
    dataDir: tempDir('companyos-t17-'),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'tools'],
  });
  database = db;
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map([['gen.tool', adapter]]),
    authorize: allow,
    events: db.events,
    secrets: async () => [],
    timer: (ms: number, onTimeout: () => void) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
  } as never);
  return { registry, db };
};

const register = async (registry: ToolRegistryPort): Promise<void> => {
  const record = createToolRecord({
    toolId: 'gen.tool', name: 'gen.tool', description: 'generic', version: '1.0.0',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    riskLevel: 'LOW', idempotencyMode: 'IDEMPOTENT_KEY', adapterRef: 'gen.tool', now: clock.nowIso(),
  });
  expect(record.ok).toBe(true);
  if (!record.ok) return;
  expect((await registry.register(record.value, { actorId: ACTOR })).ok).toBe(true);
};

const invoke = (registry: ToolRegistryPort, key: string) =>
  registry.invoke({
    toolId: 'gen.tool', executionId: 'exec_1', agentId: ACTOR, taskId: 'task_1', runId: 'run_1',
    actorId: ACTOR, input: { payload: 'x' }, idempotencyKey: key,
  });

describe('tool invocation durable replay output (ADR-0018)', () => {
  it('success replay: same key restores the ORIGINAL output with one adapter call', async () => {
    const h = make();
    await register(h.registry);
    const first = await invoke(h.registry, 'key-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);
    expect(first.value.output).toEqual(OUTPUT);
    const callsAfterFirst = adapterCalls;

    const second = await invoke(h.registry, 'key-1');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.output).toEqual(OUTPUT); // restored, not null
    expect(adapterCalls).toBe(callsAfterFirst); // adapter executed exactly once
    // Durable execution timestamps survive the replay (original times, §20):
    expect(second.value.startedAt).toBe(first.value.startedAt);
    expect(second.value.finishedAt).toBe(first.value.finishedAt);
  });

  it('output integrity: a tampered snapshot fails closed against the recorded digest', async () => {
    const h = make();
    await register(h.registry);
    expect((await invoke(h.registry, 'key-2')).ok).toBe(true);
    // Tamper with the durable snapshot while keeping the original digest:
    h.db.db
      .prepare('UPDATE tool_invocations SET replay_output_json = ? WHERE idempotency_key = ?')
      .run(JSON.stringify({ verdict: 'fail', tampered: true }), 'key-2');

    const replayed = await invoke(h.registry, 'key-2');
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.error.code).toBe('PERSISTENCE_FAILED');
      expect((replayed.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('TOOL_REPLAY_OUTPUT_CORRUPT');
    }
    expect(adapterCalls).toBe(1); // never "repaired" by re-execution
  });

  it('legacy successful invocation without a snapshot fails closed (no silent output:null)', async () => {
    const h = make();
    await register(h.registry);
    expect((await invoke(h.registry, 'key-3')).ok).toBe(true);
    // Simulate a pre-0004 row: drop the snapshot, keep status/digest.
    h.db.db
      .prepare('UPDATE tool_invocations SET replay_output_json = NULL WHERE idempotency_key = ?')
      .run('key-3');

    const replayed = await invoke(h.registry, 'key-3');
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect((replayed.error as DomainError & { details?: { reason?: string } }).details?.reason).toBe('TOOL_REPLAY_OUTPUT_UNAVAILABLE');
    }
  });

  it('a different idempotency key still executes a fresh invocation', async () => {
    const h = make();
    await register(h.registry);
    expect((await invoke(h.registry, 'key-4a')).ok).toBe(true);
    const calls = adapterCalls;
    const fresh = await invoke(h.registry, 'key-4b');
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.replayed).toBe(false);
    expect(adapterCalls).toBe(calls + 1);
  });
});

describe('tool invocation version provenance (ADR-0019)', () => {
  it('persists the executing version at creation and replays the SAME version (§20/§25)', async () => {
    const h = make();
    await register(h.registry);
    const first = await invoke(h.registry, 'key-v1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.toolVersion).toBe('1.0.0');
    const row = h.db.db.prepare('SELECT tool_version FROM tool_invocations WHERE idempotency_key = ?').get('key-v1') as { tool_version: string | null };
    expect(row.tool_version).toBe('1.0.0');

    // Simulate a registry upgrade (same toolId, new version):
    h.db.db.prepare('UPDATE tool_records SET version = ? WHERE tool_id = ?').run('2.0.0', 'gen.tool');
    const replayed = await invoke(h.registry, 'key-v1');
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.toolVersion).toBe('1.0.0'); // durable provenance, NOT current 2.0.0
    expect(replayed.value.output).toEqual(OUTPUT);
    expect(adapterCalls).toBe(1);
  });

  it('keeps a legacy null version distinguishable (never silently current)', async () => {
    const h = make();
    await register(h.registry);
    expect((await invoke(h.registry, 'key-legacy')).ok).toBe(true);
    h.db.db.prepare('UPDATE tool_invocations SET tool_version = NULL WHERE idempotency_key = ?').run('key-legacy');
    h.db.db.prepare('UPDATE tool_records SET version = ? WHERE tool_id = ?').run('9.9.9', 'gen.tool');
    const replayed = await invoke(h.registry, 'key-legacy');
    expect(replayed.ok).toBe(true); // generic tool replay stays compatible (§15)
    if (!replayed.ok) return;
    expect(replayed.value.toolVersion).toBeNull(); // UNKNOWN, not 9.9.9
  });
});
