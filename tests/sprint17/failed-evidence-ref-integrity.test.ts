import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-04 FINAL VERIFICATION — failed invocation evidence reference integrity.
 *
 * Freeze (Boss ruling): a FAILED invocation's artifact references MUST NOT be trusted merely
 * because `DomainError.details.artifactRefs` contains them. The FAILED path must carry the
 * COMPLETED path's equivalent rule — format validation, durable existence/reference
 * validation, run-ownership validation — and the linkage must be transactionally safe.
 *
 * Both linking paths (the registry's FAILED terminal write and the process tools'
 * cancel/timeout path) go through ONE shared validating linker, so the semantics are
 * identical for every adapter and no repository-specific bypass exists.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifact,
  createToolRecord,
  domainError,
  ok,
  type DomainError,
  type Result,
  type ToolPort,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';
import {
  REPOSITORY_PROCESS_TOOL_SPECS,
  createAuthorizationService,
  createRepositoryProcessToolPort,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
  resolveDurableReferences,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17ref-'));
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
  id: (prefix = 'id') => `${prefix}_17R${String(++seq).padStart(10, '0')}`,
  ulid: () => `17R${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

/** A durable Artifact row in the given run (the managed-ref grammar the resolver accepts). */
const putArtifact = async (
  db: ReturnType<typeof openDurableDatabase>,
  runId: string,
  contentRef: string,
): Promise<string> => {
  const built = createArtifact({
    runId: runId as never,
    kind: 'test:evidence',
    contentRef,
    contentHash: 'a'.repeat(64),
    sizeBytes: 16,
    producedBy: 'test',
    now: nowIso(),
    ids,
  });
  if (!built.ok) throw new Error(built.error.message);
  await db.artifactStore?.create(built.value, {
    creationCommandId: ids.id('cmd'),
    creationCommandFingerprint: 'f'.repeat(64),
  });
  return `artifact:${built.value.id}`;
};

interface Graph {
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly actor: string;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly nextRunId: () => string;
  readonly invoke: (
    toolId: string,
    input: Readonly<Record<string, unknown>>,
    runId?: string,
  ) => Promise<
    Result<
      { readonly status: string; readonly invocationId: string; readonly output: unknown; readonly artifactRefs: readonly string[] },
      DomainError
    >
  >;
}

/** THE shared validating linker, exactly as composition builds it (resolver + stores). */
const makeGraph = async (
  adapters: ReadonlyMap<string, ToolPort>,
  options: { readonly throwOnLink?: number; readonly dataDir?: string } = {},
): Promise<Graph> => {
  const db = openDurableDatabase({
    dataDir: options.dataDir ?? tempDir(),
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'provider', 'tools', 'artifact'],
  });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  // The resolver is the same shared helper composition uses (identity + run anchor).
  const resolver = async (
    refs: readonly string[],
  ): Promise<
    Result<
      readonly { readonly kind: string; readonly id: string; readonly ref: string; readonly runId: string }[],
      DomainError
    >
  > => {
    if (db.artifactStore === null || db.validationStore === null) {
      return err(domainError('PERSISTENCE_FAILED', 'artifact persistence unavailable'));
    }
    const resolved = await resolveDurableReferences(refs, {
      artifactStore: db.artifactStore,
      validationStore: db.validationStore,
    });
    if (!resolved.ok) return err(resolved.error);
    const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
    for (const reference of resolved.references) {
      const row =
        reference.kind === 'artifact'
          ? await db.artifactStore.get(reference.id as never)
          : await db.validationStore.get(reference.id as never);
      if (row === null) {
        return err(
          domainError('NOT_FOUND', `Referenced ${reference.kind} "${reference.ref}" vanished during resolution.`, {
            reason: 'ARTIFACT_REFERENCE_MISSING',
            reference: reference.ref,
          }),
        );
      }
      anchored.push({
        kind: reference.kind,
        id: reference.id,
        ref: reference.ref,
        runId: (row as { runId: string }).runId,
      });
    }
    return ok(anchored);
  };

  // Optionally fail a link write to observe transaction safety.
  let linkAttempts = 0;
  const rawArtifacts = db.toolInvocationArtifacts;
  const failingArtifacts = options.throwOnLink === undefined
    ? rawArtifacts
    : ({
        ...rawArtifacts,
        put: async (entity: { id: string; invocationId: string; artifactRef: string; label: string; createdAt: string }) => {
          linkAttempts += 1;
          if (linkAttempts === options.throwOnLink) throw new Error('simulated relation write failure');
          await rawArtifacts.put(entity);
        },
      } as typeof rawArtifacts);

  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: failingArtifacts,
    adapters,
    authorize: async (input) => authz.decide(input),
    events: db.events,
    secrets: async () => [],
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
    durableReferenceResolver: resolver,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  // The probe tool is registered here; its adapter is supplied (and may be swapped) by the
  // caller through the shared adapters map.
  const probeRecord = createToolRecord({
    toolId: 'test.forge',
    name: 'Forging probe',
    description: 'Test-only adapter that reports caller-supplied artifact refs.',
    version: '1.0.0',
    capabilities: ['read'],
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    riskLevel: 'LOW',
    requiredAuthorities: ['tool.invoke'],
    timeoutMs: 10_000,
    idempotencyMode: 'NONE',
    auditPolicy: 'STANDARD',
    providerKind: 'test',
    adapterRef: 'test.forge',
    now: nowIso(),
  });
  if (!probeRecord.ok) throw new Error(probeRecord.error.message);
  const probeRegistered = await registry.register(probeRecord.value, { actorId: actor });
  if (!probeRegistered.ok && probeRegistered.error.code !== 'CONFLICT') {
    throw new Error(probeRegistered.error.message);
  }
  return {
    db,
    actor,
    registry,
    nextRunId: () => ids.id('run'),
    invoke: async (toolId, input, runId) => {
      const outcome = await registry.invoke({
        toolId,
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: runId ?? ids.id('run'),
        actorId: actor,
        input,
      });
      if (!outcome.ok) {
        return {
          ok: false as const,
          error: outcome.error,
        };
      }
      return ok({
        status: outcome.value.status,
        invocationId: outcome.value.invocationId,
        output: outcome.value.output,
        artifactRefs: outcome.value.artifactRefs,
      });
    },
  };
};

/** A bespoke adapter that FAILS while reporting the given artifact refs (the forgery probe). */
const forgingAdapter = (
  refs: readonly string[],
  mode: 'fail' | 'succeed' = 'fail',
): ToolPort => {
  const spec = {
    toolId: 'test.forge',
    name: 'Forging probe',
    description: 'Test-only adapter that reports caller-supplied artifact refs.',
    version: '1.0.0',
    riskLevel: 'LOW' as const,
    capabilities: ['read'],
    idempotencyMode: 'NONE' as const,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
  };
  return {
    describe: () => ({ ...spec, parameters: spec.inputSchema }),
    async invoke(_request: ToolRequest): Promise<Result<ToolResult, DomainError>> {
      if (mode === 'fail') {
        return err(
          domainError('AGENT_UNAVAILABLE', 'The probe failed on purpose.', {
            kind: 'TOOL_FAILED',
            reason: 'PROBE_FAILURE',
            artifactRefs: refs,
          }),
        );
      }
      return ok({
        status: 'ok' as const,
        output: { workspaceId: 'w' },
        artifactRefs: [...refs],
        startedAt: nowIso(),
        finishedAt: nowIso(),
        latencyMs: 1,
      });
    },
  };
};

const err = <T,>(error: DomainError): Result<T, DomainError> => ({ ok: false as const, error });

const refsOf = async (graph: Graph, invocationId: string): Promise<readonly string[]> => {
  const row = await graph.db.toolInvocations.get(invocationId);
  if (row === null) throw new Error('invocation is not durable');
  return [...row.artifactRefs].sort();
};

/* ------------------------------------------------------- FAILED ref policy --- */

describe('failed invocation evidence reference integrity (T17-04 final verification)', () => {
  it('1. refuses a nonexistent managed ref reported by a failing adapter', async () => {
    const adapters = new Map<string, ToolPort>([['test.forge', forgingAdapter(['artifact:art_does_not_exist'])]]);
    const graph = await makeGraph(adapters);
    const outcome = await graph.invoke('test.forge', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    // The invocation stays honestly FAILED with its own classification.
    const refs = await refsOf(graph, String(outcome.error.details['invocationId']));
    expect(refs).toEqual([]);
    const row = await graph.db.toolInvocations.get(String(outcome.error.details['invocationId']));
    expect(row?.status).toBe('FAILED');
    expect(row?.errorKind).toBe('TOOL_FAILED');
    // The refusal is reported, never silently dropped, and the forged ref is NOT advertised.
    expect((outcome.error.details['rejectedArtifactRefs'] as readonly string[] | undefined) ?? []).toContain(
      'artifact:art_does_not_exist',
    );
    expect(outcome.error.details['evidenceRefValidation']).toBe('ARTIFACT_REFERENCE_INVALID');
    expect((outcome.error.details['artifactRefs'] as readonly string[] | undefined) ?? []).not.toContain(
      'artifact:art_does_not_exist',
    );
  });

  it('2. links a valid managed ref that belongs to the invocation run', async () => {
    const adapters = new Map<string, ToolPort>();
    const graph = await makeGraph(adapters);
    const runId = graph.nextRunId();
    const ref = await putArtifact(graph.db, runId, 'sha256:' + 'b'.repeat(64));
    adapters.set('test.forge', forgingAdapter([ref]));
    const outcome = await graph.invoke('test.forge', {}, runId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const invocationId = String(outcome.error.details['invocationId']);
    const refs = await refsOf(graph, invocationId);
    expect(refs).toEqual([ref]);
  });

  it('3. links a repeatedly reported ref exactly once', async () => {
    const adapters = new Map<string, ToolPort>();
    const graph = await makeGraph(adapters);
    const runId = graph.nextRunId();
    const ref = await putArtifact(graph.db, runId, 'sha256:' + 'c'.repeat(64));
    adapters.set('test.forge', forgingAdapter([ref]));
    const first = await graph.invoke('test.forge', {}, runId);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    const invocationId = String(first.error.details['invocationId']);
    const rows = (await graph.db.toolInvocationArtifacts.list({ limit: 50 })).items.filter(
      (item) => item.invocationId === invocationId,
    );
    expect(rows).toHaveLength(1);

    // A second failure reporting the same ref for the SAME invocation adds nothing.
    const linker = await import('@companyos/engine').then((engine) =>
      engine.createFailureEvidenceLinker({
        invocations: graph.db.toolInvocations,
        invocationArtifacts: graph.db.toolInvocationArtifacts,
        ids,
        clock,
      }),
    );
    const again = await linker.link({ invocationId, refs: [ref, ref] });
    expect(again.linked).toEqual([]);
    const after = (await graph.db.toolInvocationArtifacts.list({ limit: 50 })).items.filter(
      (item) => item.invocationId === invocationId,
    );
    expect(after).toHaveLength(1);
  });

  it('4. refuses a malformed ref and keeps a CAS ref format-checked', async () => {
    const adapters = new Map<string, ToolPort>();
    const graph = await makeGraph(adapters);
    const casRef = 'sha256:' + 'd'.repeat(64);
    adapters.set(
      'test.forge',
      forgingAdapter(['not-a-ref', '', casRef, 42 as unknown as string]),
    );
    const outcome = await graph.invoke('test.forge', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const refs = await refsOf(graph, String(outcome.error.details['invocationId']));
    // Only the well-formed CAS ref is linked; malformed and non-string entries are refused.
    expect(refs).toEqual([casRef]);
    const rejected = (outcome.error.details['rejectedArtifactRefs'] as readonly string[] | undefined) ?? [];
    expect(rejected).toContain('not-a-ref');
    expect(rejected.length).toBe(3);
  });

  it('5. refuses a managed ref that belongs to ANOTHER run (provenance isolation)', async () => {
    const adapters = new Map<string, ToolPort>();
    const graph = await makeGraph(adapters);
    const otherRun = await putArtifact(graph.db, 'run_someone_else', 'sha256:' + 'e'.repeat(64));
    adapters.set('test.forge', forgingAdapter([otherRun]));
    const outcome = await graph.invoke('test.forge', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const refs = await refsOf(graph, String(outcome.error.details['invocationId']));
    expect(refs).toEqual([]);
    const rejected = (outcome.error.details['rejectedArtifactRefs'] as readonly string[] | undefined) ?? [];
    expect(rejected).toContain(otherRun);
  });

  it('6. keeps the COMPLETED managed-ref rule unchanged', async () => {
    const adapters = new Map<string, ToolPort>();
    const graph = await makeGraph(adapters);
    const runId = graph.nextRunId();
    const ref = await putArtifact(graph.db, runId, 'sha256:' + 'f'.repeat(64));
    // A COMPLETED result with a valid managed ref: resolved and linked as before.
    adapters.set('test.forge', forgingAdapter([ref], 'succeed'));
    const good = await graph.invoke('test.forge', {}, runId);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.status).toBe('COMPLETED');
    expect([...good.value.artifactRefs].sort()).toEqual([ref]);

    // A COMPLETED result with a nonexistent managed ref still fails OUTPUT_INVALID.
    adapters.set('test.forge', forgingAdapter(['artifact:art_missing'], 'succeed'));
    const bad = await graph.invoke('test.forge', {});
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe('VALIDATION_FAILED');
    const row = await graph.db.toolInvocations.get(String(bad.error.details['invocationId']));
    expect(row?.status).toBe('FAILED');
    expect(row?.errorKind).toBe('OUTPUT_INVALID');
    const refs = await refsOf(graph, String(bad.error.details['invocationId']));
    expect(refs).toEqual([]);
  });

  it('7. links timeout/cancel evidence through the SAME validating linker', async () => {
    const scriptDir = tempDir();
    const fs = await import('node:fs');
    fs.writeFileSync(join(scriptDir, 'sleep.js'), 'setTimeout(() => {}, 120000);', 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'sleep.js'));
    const db = openDurableDatabase({
      dataDir: tempDir(),
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools'],
    });
    openDatabases.push(db);
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const manager = createWorkspaceManager();
    const opened = await manager.openWorkspace({
      root: scriptDir,
      commandProfile: {
        tests: {
          commandKey: 'tests',
          executable: process.execPath,
          baseArgv: [join(scriptDir, 'sleep.js')],
          cwd: 'workspace-root',
          safeEnvAdditions: {},
        },
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);

    // A REFUSING linker: if the cancel path wrote links directly, this would not stop it.
    const seen: string[][] = [];
    const refusingLinker = async (input: {
      readonly invocationId: string;
      readonly refs: readonly string[];
    }): Promise<{ readonly linked: readonly string[]; readonly rejected: readonly string[] }> => {
      seen.push([...input.refs]);
      return { linked: [], rejected: [...input.refs] };
    };
    const spec = REPOSITORY_PROCESS_TOOL_SPECS.find((entry) => entry.toolId === 'repo.test-runner');
    if (spec === undefined) throw new Error('no spec');
    const port = createRepositoryProcessToolPort(spec, {
      workspace: () => manager.current(),
      clock,
      runner: {
        // A run that never settles on its own: only the registry's timeout (and its cancel)
        // can end it, which is exactly the path under test.
        run: async () => new Promise<Result<never, DomainError>>(() => undefined),
        cancel: async () => ok(true as const),
        cancelAndAwait: async () =>
          ok({
            commandKey: 'tests',
            workspaceId: opened.value.workspaceId,
            exitCode: -1,
            signal: 'SIGKILL',
            durationMs: 5,
            termination: 'TIMEOUT' as const,
            // A real run would have externalized these; the probe carries a CAS-shaped ref so
            // the cancel path has something to offer the validating linker.
            stdout: {
              byteCount: 12,
              sha256: 'sha256:' + '0'.repeat(64),
              binary: false,
              preview: 'timeout out',
              truncated: false,
              artifactRef: 'sha256:' + 'a'.repeat(64),
            },
            stderr: { byteCount: 0, sha256: 'sha256:' + '1'.repeat(64), binary: false, preview: '', truncated: false, artifactRef: '' },
          }),
        activeCount: () => 0,
      },
      linkInvocationArtifacts: refusingLinker,
    });
    const registry = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters: new Map([['repo.test-runner', port]]),
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
    // A test-only short timeout so the registry's timeout race actually fires.
    const record = createToolRecord({
      toolId: spec.toolId,
      name: spec.name,
      description: spec.description,
      version: spec.version,
      capabilities: spec.capabilities,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      riskLevel: spec.riskLevel,
      requiredAuthorities: ['tool.invoke'],
      timeoutMs: 500,
      idempotencyMode: spec.idempotencyMode,
      auditPolicy: 'STRICT',
      providerKind: 'repository',
      adapterRef: spec.toolId,
      now: nowIso(),
    });
    if (!record.ok) throw new Error(record.error.message);
    await registry.register(record.value, { actorId: actor });
    // Deliberately NOT awaited: the adapter hangs until the registry's timeout cancels it.
    const invocation = registry.invoke({
      toolId: 'repo.test-runner',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: actor,
      input: {},
      idempotencyKey: 'integrity-timeout-probe',
    });
    invocation.catch(() => undefined);
    // The registry's timeout race fires and asks the adapter to stop; the adapter publishes
    // its evidence through the INJECTED linker, which is the validating one in production.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(seen.length).toBeGreaterThan(0);
    // Every ref the cancel path handed over was offered for validation (not written blindly).
    for (const refs of seen) {
      for (const ref of refs) {
        expect(ref).toMatch(/^(sha256:[0-9a-f]{64}|artifact:art_[A-Za-z0-9]+)$/);
      }
    }
    // Because the linker refused, nothing was linked for that invocation.
    const rows = (await db.toolInvocations.list({ limit: 10 })).items;
    const last = rows[rows.length - 1];
    if (last !== undefined) expect(last.artifactRefs).toEqual([]);
    void invocation;
    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);
  });

  it('8. preserves the terminal FAILED state when a link write fails', async () => {
    const adapters = new Map<string, ToolPort>();
    const graph = await makeGraph(adapters);
    const runId = graph.nextRunId();
    const refA = await putArtifact(graph.db, runId, 'sha256:' + 'a'.repeat(63) + '1');
    const refB = await putArtifact(graph.db, runId, 'sha256:' + 'a'.repeat(63) + '2');
    adapters.set('test.forge', forgingAdapter([refA, refB]));
    // The linker's SECOND write throws: the terminal state must already be durable.
    const throwing = await makeGraph(new Map([['test.forge', forgingAdapter([refA, refB])]]), {
      throwOnLink: 2,
    });
    const outcome = await throwing.invoke('test.forge', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const invocationId = String(outcome.error.details['invocationId']);
    const row = await throwing.db.toolInvocations.get(invocationId);
    expect(row?.status).toBe('FAILED');
    expect(row?.errorKind).toBe('TOOL_FAILED');
    // A partial link set is possible (a subset), but never a link without a terminal state.
    const linked = await refsOf(throwing, invocationId);
    expect(linked.length).toBeLessThanOrEqual(1);
    expect(linked.every((ref) => [refA, refB].includes(ref))).toBe(true);
  });

  it('9. retains the validated linkage in a fresh graph', async () => {
    const dataDir = tempDir();
    const adapters = new Map<string, ToolPort>();
    const first = await makeGraph(adapters, { dataDir });
    const runId = first.nextRunId();
    const ref = await putArtifact(first.db, runId, 'sha256:' + 'b'.repeat(63) + '9');
    adapters.set('test.forge', forgingAdapter([ref]));
    const outcome = await first.invoke('test.forge', {}, runId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const invocationId = String(outcome.error.details['invocationId']);
    first.db.close();
    openDatabases.splice(openDatabases.indexOf(first.db), 1);

    const reopened = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools', 'artifact'],
    });
    openDatabases.push(reopened);
    const row = await reopened.toolInvocations.get(invocationId);
    expect(row?.status).toBe('FAILED');
    expect([...(row?.artifactRefs ?? [])].sort()).toEqual([ref]);
    // The referenced artifact row itself is still durable: no dangling provenance.
    const artifactRow = await reopened.artifactStore?.get(ref.slice('artifact:'.length) as never);
    expect(artifactRow).not.toBeNull();
    void dataDir;
  });
});
