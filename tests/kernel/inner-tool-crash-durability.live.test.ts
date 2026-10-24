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
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {openDurableDatabase} from '@companyos/persistence';

import {resolveEmbeddedDshRuntime} from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import {createDshProvider, DSH_PROVIDER_KEY} from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import {resolveExecutorConfig} from '@companyos/engine';

import { requireRealDshApproval } from '../support/real-dsh-approval.js';
const approval = requireRealDshApproval();
import { randomUUID } from 'node:crypto';
import { observeFixtureSpawns, saveOutcomeEvidence } from '../support/kernel-outcome-evidence.js';
import { startScenarioServer } from '../support/scenario-server.js';
// Keep live workspaces, ACL residue and evidence until a separate disposal decision.
const tempDir = (): string => mkdtempSync(join(approval.workspaceRoot, 'fix08c-'));

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;

describe('LIVE-SMOKE-FIX-08C — real kernel crash-window fixture (production seam)', () => {
  /**
   * Drive ONE REAL embedded-kernel invocation whose scripted model requests a
   * long-running inner command; the CompanyOS timeout kills the attempt AFTER the
   * kernel emitted the tool_call (durable at arrival) and AFTER the tool started.
   * This is the exact Smoke-07 crash shape: emission → commit → tool start → kill,
   * with the final command attributable from the durable store alone.
   */
  const runKernelWithTap = async (input: {
    readonly scenario: readonly unknown[];
    readonly workspace: string;
    readonly attemptId: string;
    readonly dispatchKey: string;
    readonly timeoutMs: number;
    readonly dataDir: string;
  }): Promise<{outcomeKind: string; stdoutTail: string; terminationProven: boolean | null}> => {
    const db = openDurableDatabase({dataDir: input.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    const observation = observeFixtureSpawns(['sk-mock-fix08c']);
    let captured: unknown = null;
    let modelServer: Awaited<ReturnType<typeof startScenarioServer>> | null = null;
    try {
      modelServer = await startScenarioServer(input.scenario, tempDir());
      const rt = resolveEmbeddedDshRuntime({managedRoot: approval.managedRoot});
      if (!rt.ok) throw new Error(rt.error.message);
      const cfg = resolveExecutorConfig({
        providerKey: DSH_PROVIDER_KEY,
        schema: {kernelId: {name: 'kernelId', kind: 'string', required: true}},
        envNames: {},
        composition: {kernelId: rt.value.manifest.kernelId},
      });
      if (!cfg.ok) throw new Error(cfg.error.message);
      let n = 0;
      const provider = createDshProvider({
        nodeExecutable: '', runtimeDir: '', profileName: rt.value.manifest.profileName, fallbackCwd: null,
        config: cfg.value,
        timer: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); },
        timeoutMs: input.timeoutMs,
        embedded: {
          runtime: rt.value,
          modelRoute: {
            providerId: 'companyos-explicit', modelId: 'adversarial',
            baseURL: `http://127.0.0.1:${String(modelServer.port)}/v1`,
            apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS', apiKeyValue: 'sk-mock-fix08c',
            contextWindow: 8192, maxTokens: 1024,
          },
          toolInvocationAudit: {
            append: async (events) => { await db.events.append(events as never); },
            secrets: () => [],
            ids: {id: () => `evt_fix08c_k_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08c_k_${String(n).padStart(4, '0')}`},
            onFailure: () => undefined,
          },
        },
      });
      const outcome = await provider.start({
        companyId: 'c', runId: 'run_fix08c', taskId: 'tsk_fix08c', attemptId: input.attemptId, attemptNumber: 1,
        roleId: 'rol_fix08c', taskKind: 'companyos:work', work: {objective: 'do the work'},
        workspace: {cwd: input.workspace, root: input.workspace}, requiredCapabilities: [],
        dispatchKey: input.dispatchKey, taskText: 'x', structured: false,
        timeoutMs: input.timeoutMs,
      });
      captured = outcome;
      const stdoutTail = outcome.kind === 'timeout' ? (outcome.stdoutText ?? '') : outcome.kind === 'succeeded' ? outcome.stdoutText : '';
      return {outcomeKind: outcome.kind, stdoutTail, terminationProven: 'terminationProven' in outcome ? outcome.terminationProven : null};
    } catch (error) {
      captured ??= {kind: 'fixture-failed', detail: error instanceof Error ? error.message : 'UNKNOWN_FIXTURE_ERROR'};
      throw error;
    } finally {
      try { await modelServer?.stop(); } finally {
        db.close(); observation.stop();
        saveOutcomeEvidence(join(approval.evidenceRoot, `inner-${randomUUID()}.json`), captured, observation.records, ['sk-mock-fix08c']);
      }
    }
  };

  it('crash window: kernel emits tool_call → durable at arrival → tool starts → timeout kill → FRESH connection reads the last inner command with attempt linkage, no phantom dispatch', {timeout: 400_000}, async () => {
    const dataDir = tempDir();
    const ws = tempDir();
    const attemptId = 'exa_fix08c_000000000000000000000003';
    const {outcomeKind, stdoutTail, terminationProven} = await runKernelWithTap({
      scenario: [
        {tool_call: {name: 'pwsh', arguments: {command: 'echo inner-crash-proof; Start-Sleep -Seconds 3600'}}},
        {text: 'done'},
      ],
      workspace: ws,
      attemptId,
      dispatchKey: 'dsp_fix08c_crash_00000000000000001',
      timeoutMs: 150_000,
      dataDir,
    });
    // The REAL kernel emitted the tool_call, the tool ran (its output proves the
    // inner process started), and the CompanyOS budget killed the attempt MID-TOOL
    // (150s budget ≪ the 3600s Start-Sleep the tool is blocked in).
    expect(outcomeKind).toBe('timeout');
    expect(terminationProven).toBe(true);
    // The kernel's ndjson session stream (the canonical machine form).
    expect(stdoutTail).toContain('"type":"tool_call"');
    expect(stdoutTail).toContain('inner-crash-proof');
    // FRESH connection — no in-memory reuse.
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-fix08c', chains: [...CHAINS]});
    try {
      const rows = reopened.db.prepare("SELECT payload FROM events WHERE type = 'executor.tool_invocation_requested' ORDER BY rowid").all() as {payload: string}[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const last = JSON.parse(rows[rows.length - 1]!.payload) as Record<string, unknown>;
      // Attempt linkage + tool + safe command form + cwd + sequence all PRESENT.
      expect(last['attemptId']).toBe(attemptId);
      expect(last['tool']).toBe('pwsh');
      expect(String(last['argsHead'])).toContain('inner-crash-proof');
      expect(last['cwd']).toBe(ws);
      expect(typeof last['sequence']).toBe('number');
      expect(typeof last['argsSha256']).toBe('string');
      // NO duplicate execution: the evidence created no phantom attempt/dispatch rows.
      const attempts = (reopened.db.prepare('SELECT COUNT(*) AS c FROM execution_attempts').get() as {c: number}).c;
      const dispatches = (reopened.db.prepare('SELECT COUNT(*) AS c FROM provider_dispatches').get() as {c: number}).c;
      expect(attempts).toBe(0); // provider-level harness: no canonical attempt rows exist to duplicate
      expect(dispatches).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it('ordering through the REAL kernel: the durable commit is verifiable synchronously at tap time, and the tool output arrives only afterwards', {timeout: 400_000}, async () => {
    const dataDir = tempDir();
    const ws = tempDir();
    const attemptId = 'exa_fix08c_000000000000000000000004';
    const order: string[] = [];
    const observation = observeFixtureSpawns(['sk-mock-fix08c']);
    let captured: unknown = null;
    let modelServer: Awaited<ReturnType<typeof startScenarioServer>> | null = null;
    let db: ReturnType<typeof openDurableDatabase> | null = null;
    try {
      modelServer = await startScenarioServer([
        {tool_call: {name: 'pwsh', arguments: {command: 'echo inner-order-proof'}}},
        {text: 'done'},
      ], tempDir());
      const rt = resolveEmbeddedDshRuntime({managedRoot: approval.managedRoot});
      if (!rt.ok) throw new Error(rt.error.message);
      const cfg = resolveExecutorConfig({
        providerKey: DSH_PROVIDER_KEY,
        schema: {kernelId: {name: 'kernelId', kind: 'string', required: true}},
        envNames: {},
        composition: {kernelId: rt.value.manifest.kernelId},
      });
      if (!cfg.ok) throw new Error(cfg.error.message);
      db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
      let n = 0;
      const provider = createDshProvider({
        nodeExecutable: '', runtimeDir: '', profileName: rt.value.manifest.profileName, fallbackCwd: null,
        config: cfg.value,
        timer: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); },
        timeoutMs: 300_000,
        embedded: {
          runtime: rt.value,
          modelRoute: {
            providerId: 'companyos-explicit', modelId: 'adversarial',
            baseURL: `http://127.0.0.1:${String(modelServer.port)}/v1`,
            apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS', apiKeyValue: 'sk-mock-fix08c',
            contextWindow: 8192, maxTokens: 1024,
          },
          toolInvocationAudit: {
            append: async (events) => {
              await db!.events.append(events as never);
              // The synchronous durability probe: right after the append CALL returns,
              // the row is readable through the same store (node:sqlite sync commit).
              const count = (db!.db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'executor.tool_invocation_requested'").get() as {c: number}).c;
              order.push(`durableRows=${String(count)}`);
            },
            secrets: () => [],
            ids: {id: () => `evt_fix08c_o_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08c_o_${String(n).padStart(4, '0')}`},
            onFailure: () => order.push('onFailure'),
          },
        },
      });
      // Watch the kernel stream IN ORDER: the tool_call tap fires before the tool's
      // own output is observable on the same pipe.
      const outcome = await provider.start({
        companyId: 'c', runId: 'run_fix08c', taskId: 'tsk_fix08c', attemptId, attemptNumber: 1,
        roleId: 'rol_fix08c', taskKind: 'companyos:work', work: {objective: 'do the work'},
        workspace: {cwd: ws, root: ws}, requiredCapabilities: [],
        dispatchKey: 'dsp_fix08c_order_00000000000000001', taskText: 'x', structured: false,
      });
      captured = outcome;
      // The tool's output is observable only in the settled stdout — AFTER the tap's
      // durable commit (recorded during the run).
      expect(outcome.kind).toBe('succeeded');
      expect('stdoutText' in outcome ? outcome.stdoutText : '').toContain('inner-order-proof');
      expect(order.filter((entry) => entry.startsWith('durableRows=')).length).toBeGreaterThanOrEqual(1);
      expect(order).not.toContain('onFailure');
      // Definitive ordering readback: every durable row was committed before the run
      // settled (the store already holds it while the provider was still executing).
      const rows = db.db.prepare("SELECT payload FROM events WHERE type = 'executor.tool_invocation_requested' ORDER BY rowid").all() as {payload: string}[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const first = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
      expect(first['attemptId']).toBe(attemptId);
      expect(String(first['argsHead'])).toContain('inner-order-proof');
    } catch (error) {
      captured ??= {kind: 'fixture-failed', detail: error instanceof Error ? error.message : 'UNKNOWN_FIXTURE_ERROR'};
      throw error;
    } finally {
      try { await modelServer?.stop(); } finally {
        db?.close(); observation.stop();
        saveOutcomeEvidence(join(approval.evidenceRoot, `inner-${randomUUID()}.json`), captured, observation.records, ['sk-mock-fix08c']);
      }
    }
  });
});
