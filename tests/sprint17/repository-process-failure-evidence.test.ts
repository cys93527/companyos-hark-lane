import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-04 CORRECTIVE — durable failure evidence for process invocations.
 *
 * Freeze (Boss ruling): EVERY invocation whose process actually started — COMPLETED, FAILED,
 * TIMEOUT, CANCELLED or OUTPUT_LIMIT_EXCEEDED — must be reconstructable from DURABLE data
 * alone: identity, workspaceId, commandKey, exitCode/signal/duration, per-stream byteCount /
 * sha256 / binary / bounded preview / artifactRef, and the failure classification.
 *
 * The evidence object and the full stream bytes live in the EXISTING Artifact/CAS store and
 * are linked to the invocation through the EXISTING `tool_invocation_artifacts` relation, so
 * no migration, no second blob store, and no change to status or replay semantics is
 * involved. These tests read it back from a FRESH service graph: no in-memory adapter, no
 * caller memory, no CAS scan, no log or filename inference.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DomainError, createToolRecord, ok, type Result } from '@companyos/core';
import {
  MAX_PROCESS_CAPTURE_BYTES,
  MAX_PROCESS_INLINE_PREVIEW_BYTES,
  REPOSITORY_PROCESS_TOOL_SPECS,
  createAuthorizationService,
  createFailureEvidenceLinker,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
  resolveDurableReferences,
  type RepositoryProcessRunner,
  type RepositoryProcessToolSpec,
  type WorkspaceManager,
} from '@companyos/engine';
import { createFilesystemArtifactContentStore, openDurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17ev-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_17E${String(++seq).padStart(10, '0')}`,
  ulid: () => `17E${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const MIB = 1024 * 1024;
const EVIDENCE_SCHEMA = 'companyos/repository-process-evidence/1';

/** Controlled fixture scripts: `process.execPath` + a fixed script, never a shell. */
const SCRIPTS: Readonly<Record<string, string>> = {
  'ok.js': `process.stdout.write('clean run' + String.fromCharCode(10));process.exit(0);`,
  'fail-a.js': `process.stdout.write('alpha stdout' + String.fromCharCode(10));process.stderr.write('alpha failing detail' + String.fromCharCode(10));process.exit(7);`,
  'fail-b.js': `process.stdout.write('beta stdout' + String.fromCharCode(10));process.stderr.write('beta failing detail' + String.fromCharCode(10));process.exit(3);`,
  // 64 KiB on BOTH streams, then a non-zero exit: the full bytes exceed the inline preview.
  'noisy-fail.js': `const a = Buffer.alloc(1024, 0x61);for (let i = 0; i < 64; i += 1) process.stdout.write(a);const b = Buffer.alloc(1024, 0x62);for (let i = 0; i < 64; i += 1) process.stderr.write(b);process.exit(5);`,
  'noisy-sleep.js': `const a = Buffer.alloc(1024, 0x63);for (let i = 0; i < 32; i += 1) process.stdout.write(a);setTimeout(() => {}, 120000);`,
  'sleep.js': `setTimeout(() => {}, 120000);`,
  'flood.js': `const chunk = Buffer.alloc(${String(MIB)}, 0x7a);for (let i = 0; i < 40; i += 1) process.stdout.write(chunk);process.exit(0);`,
};

interface Fixture {
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly scriptDir: string;
  readonly manager: WorkspaceManager;
  readonly runner: RepositoryProcessRunner;
  readonly actor: string;
  readonly adapters: Map<string, ReturnType<typeof createRepositoryProcessToolPort>>;
  readonly openProfile: (slots: Readonly<Record<string, string>>) => Promise<void>;
  readonly invokeRaw: (
    toolId: RepositoryProcessToolSpec['toolId'],
    input: Readonly<Record<string, unknown>>,
  ) => Promise<
    Result<
      { readonly status: string; readonly invocationId: string; readonly output: unknown },
      DomainError
    >
  >;
}

const make = async (options: { readonly timeoutMs?: number; readonly dataDir?: string } = {}): Promise<Fixture> => {
  const scriptDir = tempDir();
  for (const [name, source] of Object.entries(SCRIPTS)) {
    writeFileSync(join(scriptDir, name), source, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, name));
  }
  const casRoot = tempDir();
  const dataDir = options.dataDir ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: ['core', 'engine', 'provider', 'tools'] });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  const manager = createWorkspaceManager();
  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const runner = createRepositoryProcessRunner({
    clock,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    contentStore,
    // The registry hands `cancel` an invocation id; ToolRequest only exposed the execution id.
    resolveExecutionId: async (invocationId) => {
      const invocation = await db.toolInvocations.get(invocationId);
      return invocation === null ? null : invocation.executionId;
    },
  });
  // THE shared validating linker (the same component the registry's FAILED terminal write
  // uses), so the cancel/timeout path cannot bypass reference validation.
  const linkInvocationArtifacts = async (input: {
    readonly invocationId: string;
    readonly refs: readonly string[];
  }): Promise<{ readonly linked: readonly string[]; readonly rejected: readonly string[] }> =>
    evidenceLinker.link(input);
  // The shared durable-reference resolution the composition root uses: identity + run anchor.
  const evidenceResolver = async (
    refs: readonly string[],
  ): Promise<
    Result<
      readonly { readonly kind: string; readonly id: string; readonly ref: string; readonly runId: string }[],
      DomainError
    >
  > => {
    if (db.artifactStore === null || db.validationStore === null) {
      return { ok: false as const, error: new DomainError('PERSISTENCE_FAILED', 'artifact persistence unavailable', {}) };
    }
    const resolved = await resolveDurableReferences(refs, {
      artifactStore: db.artifactStore,
      validationStore: db.validationStore,
    });
    if (!resolved.ok) return { ok: false as const, error: resolved.error };
    const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
    for (const reference of resolved.references) {
      const row =
        reference.kind === 'artifact'
          ? await db.artifactStore.get(reference.id as never)
          : await db.validationStore.get(reference.id as never);
      if (row === null) {
        return {
          ok: false as const,
          error: new DomainError('NOT_FOUND', `Referenced ${reference.kind} vanished during resolution.`, {
            details: { reason: 'ARTIFACT_REFERENCE_MISSING', reference: reference.ref },
          }),
        };
      }
      anchored.push({ kind: reference.kind, id: reference.id, ref: reference.ref, runId: row.runId });
    }
    return { ok: true as const, value: anchored };
  };
  const evidenceLinker = createFailureEvidenceLinker({
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    ids,
    clock,
    resolver: evidenceResolver,
  });
  const adapters = new Map<string, ReturnType<typeof createRepositoryProcessToolPort>>();
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    adapters.set(
      spec.toolId,
      createRepositoryProcessToolPort(spec, {
        workspace: () => manager.current(),
        clock,
        runner,
        contentStore,
        linkInvocationArtifacts,
      }),
    );
  }
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters,
    authorize: async (input) => authz.decide(input),
    events: db.events,
    secrets: async () => [],
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    const record =
      options.timeoutMs === undefined
        ? createRepositoryProcessToolRecord(spec, nowIso())
        : createToolRecord({
            toolId: spec.toolId,
            name: spec.name,
            description: spec.description,
            version: spec.version,
            capabilities: spec.capabilities,
            inputSchema: spec.inputSchema,
            outputSchema: spec.outputSchema,
            riskLevel: spec.riskLevel,
            requiredAuthorities: ['tool.invoke'],
            timeoutMs: options.timeoutMs,
            idempotencyMode: spec.idempotencyMode,
            auditPolicy: 'STRICT',
            providerKind: 'repository',
            adapterRef: spec.toolId,
            now: nowIso(),
          });
    if (!record.ok) throw new Error(record.error.message);
    const registered = await registry.register(record.value, { actorId: actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  }

  return {
    db,
    dataDir,
    casRoot,
    scriptDir,
    manager,
    runner,
    actor,
    adapters,
    openProfile: async (slots) => {
      const commandProfile: Record<string, {
        readonly commandKey: string;
        readonly executable: string;
        readonly baseArgv: readonly string[];
        readonly cwd: 'workspace-root';
        readonly safeEnvAdditions: Readonly<Record<string, string>>;
      }> = {};
      for (const [commandKey, script] of Object.entries(slots)) {
        commandProfile[commandKey] = {
          commandKey,
          executable: process.execPath,
          baseArgv: [join(scriptDir, script)],
          cwd: 'workspace-root',
          safeEnvAdditions: {},
        };
      }
      const opened = await manager.openWorkspace({ root: scriptDir, commandProfile });
      if (!opened.ok) throw new Error(opened.error.message);
    },
    // Always resolves: an error outcome carries its invocation id, so a failed call can still
    // be inspected durably (the registry's own timeout verdict is an error, not an outcome).
    invokeRaw: async (toolId, input) => {
      const outcome = await registry.invoke({
        toolId,
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: actor,
        input,
      });
      if (!outcome.ok) {
        return ok({
          status: 'FAILED',
          invocationId: String(outcome.error.details['invocationId'] ?? ''),
          output: outcome.error.details,
        });
      }
      return ok({
        status: outcome.value.status,
        invocationId: outcome.value.invocationId,
        output: outcome.value.output,
      });
    },
  };
};

/** Durable read of one invocation: the row plus the refs its relation carries. */
const durableInvocation = async (
  db: ReturnType<typeof openDurableDatabase>,
  invocationId: string,
): Promise<{ readonly row: Record<string, unknown>; readonly refs: readonly string[] }> => {
  const row = await db.toolInvocations.get(invocationId);
  if (row === null) throw new Error(`invocation ${invocationId} is not durable`);
  return { row: row as unknown as Record<string, unknown>, refs: [...row.artifactRefs].sort() };
};

/** Recover the failure evidence through the invocation's OWN refs — never a CAS scan. */
const recoverEvidence = async (casRoot: string, refs: readonly string[]): Promise<Record<string, unknown>> => {
  const store = createFilesystemArtifactContentStore({ casRoot });
  for (const ref of refs) {
    const bytes = await store.get(ref);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      continue; // a stream blob, not the evidence object
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['schema'] === EVIDENCE_SCHEMA
    ) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error('no durable failure evidence found among the claimed refs');
};

const streamOf = (evidence: Record<string, unknown>, stream: 'stdout' | 'stderr'): Record<string, unknown> =>
  evidence[stream] as Record<string, unknown>;

/* ------------------------------------------------------------- evidence ---- */

describe('durable process failure evidence (T17-04 corrective)', () => {
  it('1-3. keeps a non-zero exit reconstructable with both stream refs linked', async () => {
    const f = await make();
    await f.openProfile({ tests: 'noisy-fail.js' });
    const outcome = await f.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('FAILED');

    // The invocation is FAILED — the status is never dressed up as a success.
    const durable = await durableInvocation(f.db, outcome.value.invocationId);
    expect(durable.row['status']).toBe('FAILED');
    expect(durable.row['errorKind']).toBe('TOOL_FAILED');

    // Durable linkage: the refs come from the invocation's own relation row.
    expect(durable.refs.length).toBeGreaterThanOrEqual(3);
    const evidence = await recoverEvidence(f.casRoot, durable.refs);
    expect(evidence['toolId']).toBe('repo.test-runner');
    expect(evidence['commandKey']).toBe('tests');
    expect(evidence['exitCode']).toBe(5);
    expect(evidence['termination']).toBe('EXITED');
    expect(typeof evidence['durationMs']).toBe('number');

    // stdout + stderr full bytes are each externalized and linked.
    const stdout = streamOf(evidence, 'stdout');
    const stderr = streamOf(evidence, 'stderr');
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(stderr['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(durable.refs).toContain(String(stdout['artifactRef']));
    expect(durable.refs).toContain(String(stderr['artifactRef']));

    const store = createFilesystemArtifactContentStore({ casRoot: f.casRoot });
    const stdoutBytes = await store.get(String(stdout['artifactRef']));
    const stderrBytes = await store.get(String(stderr['artifactRef']));
    expect(stdoutBytes.byteLength).toBe(64 * 1024);
    expect(stderrBytes.byteLength).toBe(64 * 1024);
    expect(digest(stdoutBytes)).toBe(stdout['sha256']);
    expect(digest(stderrBytes)).toBe(stderr['sha256']);
  });

  it('4. keeps failure previews bounded at 16 KiB per stream', async () => {
    const f = await make();
    await f.openProfile({ tests: 'noisy-fail.js' });
    const outcome = await f.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const durable = await durableInvocation(f.db, outcome.value.invocationId);
    const evidence = await recoverEvidence(f.casRoot, durable.refs);
    for (const stream of ['stdout', 'stderr'] as const) {
      const summary = streamOf(evidence, stream);
      expect(Buffer.from(String(summary['preview']), 'utf8').byteLength).toBe(MAX_PROCESS_INLINE_PREVIEW_BYTES);
      expect(summary['truncated']).toBe(true);
      expect(Number(summary['byteCount'])).toBeGreaterThan(MAX_PROCESS_INLINE_PREVIEW_BYTES);
    }
    // The durable evidence object itself stays small: previews only, never the full streams.
    const store = createFilesystemArtifactContentStore({ casRoot: f.casRoot });
    for (const ref of durable.refs) {
      const bytes = await store.get(ref);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        parsed = null;
      }
      if ((parsed as Record<string, unknown> | null)?.['schema'] === EVIDENCE_SCHEMA) {
        expect(bytes.byteLength).toBeLessThan(64 * 1024);
      } else {
        // A stream blob never exceeds the capture cap.
        expect(bytes.byteLength).toBeLessThanOrEqual(MAX_PROCESS_CAPTURE_BYTES);
      }
    }
  });

  it('5. keeps the failure CAS bytes exact', async () => {
    const f = await make();
    await f.openProfile({ tests: 'fail-a.js' });
    const outcome = await f.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const durable = await durableInvocation(f.db, outcome.value.invocationId);
    const evidence = await recoverEvidence(f.casRoot, durable.refs);
    const stdout = streamOf(evidence, 'stdout');
    const stderr = streamOf(evidence, 'stderr');
    expect(String(stdout['preview'])).toBe('alpha stdout\n');
    expect(String(stderr['preview'])).toBe('alpha failing detail\n');
    expect(Number(stdout['byteCount'])).toBe('alpha stdout\n'.length);
    expect(Number(stderr['byteCount'])).toBe('alpha failing detail\n'.length);
  });

  it('6. keeps timeout evidence durable (the registry verdict discards adapter details)', async () => {
    const f = await make({ timeoutMs: 700 });
    await f.openProfile({ tests: 'sleep.js' });
    const outcome = await f.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The registry's own verdict: TIMEOUT, and the child process is really gone.
    expect(outcome.value.status).toBe('FAILED');
    const durable = await durableInvocation(f.db, outcome.value.invocationId);
    expect(durable.row['errorKind']).toBe('TIMEOUT');
    expect(durable.refs.length).toBeGreaterThanOrEqual(1);
    const evidence = await recoverEvidence(f.casRoot, durable.refs);
    expect(evidence['termination']).toBe('TIMEOUT');
    expect(evidence['commandKey']).toBe('tests');
    expect(evidence['toolId']).toBe('repo.test-runner');
  });

  it('7. keeps output-limit evidence durable', async () => {
    const f = await make();
    await f.openProfile({ tests: 'flood.js' });
    const outcome = await f.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const durable = await durableInvocation(f.db, outcome.value.invocationId);
    expect(durable.row['status']).toBe('FAILED');
    expect(durable.row['errorKind']).toBe('TOOL_FAILED');
    const evidence = await recoverEvidence(f.casRoot, durable.refs);
    expect(evidence['termination']).toBe('OUTPUT_LIMIT');
    const stdout = streamOf(evidence, 'stdout');
    expect(Number(stdout['byteCount'])).toBeGreaterThan(MAX_PROCESS_CAPTURE_BYTES);
    expect(stdout['truncated']).toBe(true);
    // The captured (capped) bytes are still published, never the whole unbounded stream.
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    const store = createFilesystemArtifactContentStore({ casRoot: f.casRoot });
    expect((await store.get(String(stdout['artifactRef']))).byteLength).toBeLessThanOrEqual(
      MAX_PROCESS_CAPTURE_BYTES,
    );
  });

  it('8. keeps cancellation evidence durable where output exists', async () => {
    const f = await make();
    await f.openProfile({ tests: 'noisy-sleep.js' });
    const pending = f.invokeRaw('repo.test-runner', {});
    await sleep(400);
    // The adapter's cancel seam is what the registry's timeout path uses; here it is driven
    // directly so an explicit cancellation is observed.
    const invocation = (await f.db.toolInvocations.list({ limit: 10 })).items.find(
      (item) => item.toolId === 'repo.test-runner',
    );
    expect(invocation).toBeDefined();
    const adapter = f.adapters.get('repo.test-runner');
    if (adapter === undefined) throw new Error('the repo.test-runner adapter is not wired');
    const invocationId = String(invocation?.id);
    const cancelled = await adapter.cancel?.(invocationId);
    expect(cancelled?.ok).toBe(true);
    await pending;
    const durable = await durableInvocation(f.db, invocationId);
    expect(durable.row['status']).toBe('FAILED');
    const evidence = await recoverEvidence(f.casRoot, durable.refs);
    expect(evidence['termination']).toBe('CANCELLED');
    const stdout = streamOf(evidence, 'stdout');
    // Output produced before the cancellation is preserved and externalized.
    expect(Number(stdout['byteCount'])).toBe(32 * 1024);
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(durable.refs).toContain(String(stdout['artifactRef']));
  });

  it('9. recovers the failure evidence from a FRESH service graph after restart', async () => {
    const dataDir = tempDir();
    const first = await make({ dataDir });
    await first.openProfile({ tests: 'fail-a.js' });
    const outcome = await first.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const invocationId = outcome.value.invocationId;
    const beforeRefs = (await durableInvocation(first.db, invocationId)).refs;

    // Tear the whole graph down: database closed, no adapters, no runner, no workspace.
    first.db.close();
    openDatabases.splice(openDatabases.indexOf(first.db), 1);
    await sleep(50);

    // A brand-new graph over the SAME data directory: only durable state exists.
    const reopened = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools'],
    });
    openDatabases.push(reopened);
    const after = await durableInvocation(reopened, invocationId);
    expect(after.refs).toEqual(beforeRefs);
    const evidence = await recoverEvidence(first.casRoot, after.refs);
    expect(evidence['exitCode']).toBe(7);
    expect(evidence['commandKey']).toBe('tests');
    const store = createFilesystemArtifactContentStore({ casRoot: first.casRoot });
    const stdout = streamOf(evidence, 'stdout');
    if (String(stdout['artifactRef']).length > 0) {
      expect(new TextDecoder('utf-8').decode(await store.get(String(stdout['artifactRef'])))).toBe('alpha stdout\n');
    }
  });

  it('10. keeps a FAILED invocation FAILED after reload, with no replay dressing', async () => {
    const dataDir = tempDir();
    const first = await make({ dataDir });
    await first.openProfile({ tests: 'fail-b.js' });
    const outcome = await first.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const invocationId = outcome.value.invocationId;
    first.db.close();
    openDatabases.splice(openDatabases.indexOf(first.db), 1);

    // A FRESH graph (durable records only, no adapter wired at all). A process tool is
    // idempotencyMode NONE, so the registry derives a NULL idempotency key and the replay
    // path is unreachable for it: the durable row stays FAILED, and a new call is a NEW
    // invocation that fails again — never a replay dressed up as something else.
    const reopened = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools'],
    });
    openDatabases.push(reopened);
    const durable = await durableInvocation(reopened, invocationId);
    expect(durable.row['status']).toBe('FAILED');
    expect(durable.row['idempotencyKey']).toBeNull();
    const evidence = await recoverEvidence(first.casRoot, durable.refs);
    expect(evidence['exitCode']).toBe(3);

    const authz = createAuthorizationService({
      ids,
      clock,
      roles: reopened.roles,
      assignments: reopened.roleAssignments,
    });
    const freshRegistry = createToolRegistry({
      ids,
      clock,
      records: reopened.toolRecords,
      invocations: reopened.toolInvocations,
      invocationArtifacts: reopened.toolInvocationArtifacts,
      adapters: new Map(),
      authorize: async (input) => authz.decide(input),
      events: reopened.events,
      secrets: async () => [],
      ...(reopened.toolInvocationClaims === null ? {} : { claims: reopened.toolInvocationClaims }),
      ...(reopened.toolInvocationIndex === null ? {} : { invocationIndex: reopened.toolInvocationIndex }),
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    // No workspace is open in this fresh graph: the tool fails closed, and the ORIGINAL
    // invocation row is not touched by the new attempt.
    const again = await freshRegistry.invoke({
      toolId: 'repo.test-runner',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: first.actor,
      input: {},
    });
    expect(again.ok).toBe(false);
    const afterRetry = await durableInvocation(reopened, invocationId);
    expect(afterRetry.row['status']).toBe('FAILED');
    expect(afterRetry.refs).toEqual(durable.refs);
  });

  it('11-12. keeps evidence bound to the exact invocation, with no CAS scan or inference', async () => {
    const f = await make();
    await f.openProfile({ tests: 'fail-a.js', build: 'fail-b.js' });
    const first = await f.invokeRaw('repo.test-runner', {});
    const second = await f.invokeRaw('repo.builder', {});
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstDurable = await durableInvocation(f.db, first.value.invocationId);
    const secondDurable = await durableInvocation(f.db, second.value.invocationId);

    expect(firstDurable.refs).not.toEqual(secondDurable.refs);
    const firstEvidence = await recoverEvidence(f.casRoot, firstDurable.refs);
    const secondEvidence = await recoverEvidence(f.casRoot, secondDurable.refs);
    expect(firstEvidence['commandKey']).toBe('tests');
    expect(firstEvidence['exitCode']).toBe(7);
    expect(secondEvidence['commandKey']).toBe('build');
    expect(secondEvidence['exitCode']).toBe(3);
    expect(firstEvidence['toolId']).toBe('repo.test-runner');
    expect(secondEvidence['toolId']).toBe('repo.builder');
    // Neither invocation advertises the other's refs: provenance comes from the relation,
    // and these two runs differ, so no ref may be shared between them.
    for (const ref of secondDurable.refs) {
      expect(firstDurable.refs.includes(ref)).toBe(false);
    }
  });

  it('leaves a successful run without failure evidence (COMPLETED uses the replay snapshot)', async () => {
    const f = await make();
    await f.openProfile({ tests: 'ok.js' });
    const outcome = await f.invokeRaw('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('COMPLETED');
    const durable = await durableInvocation(f.db, outcome.value.invocationId);
    expect(durable.row['status']).toBe('COMPLETED');
    expect(durable.row['errorKind']).toBeNull();
    // The output was small: nothing externalized, nothing linked, and no evidence object.
    expect(durable.refs).toEqual([]);
    expect(durable.row['replayOutput']).not.toBeNull();
  });
});
