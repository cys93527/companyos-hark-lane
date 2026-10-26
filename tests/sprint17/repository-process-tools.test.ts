import { registerOfflineFixture, registerOfflineSpawnFailure } from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-04 — Controlled process runtime & QA command tools.
 *
 * Everything runs on the REAL ToolRegistry (authority -> risk -> schemas -> adapter ->
 * durable ToolInvocation) and the REAL RepositoryProcessRunner over `node:child_process`.
 * The trusted command profile is a controlled fixture: `process.execPath` plus small scripts
 * written into a temp dir, so no shell, no npm/pnpm/tsc toolchain and no repository command
 * is needed to prove the execution model.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DomainError, createToolRecord, ok, type Result } from '@companyos/core';
import {
  MAX_PROCESS_CAPTURE_BYTES,
  MAX_PROCESS_INLINE_PREVIEW_BYTES,
  REPOSITORY_PROCESS_TOOL_SPECS,
  buildFilteredProcessEnvironment,
  createAuthorizationService,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
  type RepositoryProcessRunner,
  type RepositoryProcessToolSpec,
  type WorkspaceContext,
  type WorkspaceManager,
} from '@companyos/engine';
import { createFilesystemArtifactContentStore, openDurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17proc-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  // Close every handle first: an open SQLite connection makes the directory unremovable.
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_17P${String(++seq).padStart(10, '0')}`,
  ulid: () => `17P${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const digest = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const MIB = 1024 * 1024;

/* ------------------------------------------------------------ fixtures ----- */

/** Controlled helper scripts: `process.execPath` runs them, so no shell is involved. */
const SCRIPTS: Readonly<Record<string, string>> = {
  'ok.js': `process.stdout.write('hello stdout' + String.fromCharCode(10));process.stderr.write('hello stderr' + String.fromCharCode(10));process.exitCode = 0;`,
  'fail.js': `process.stdout.write('partial out' + String.fromCharCode(10));process.stderr.write('failure detail' + String.fromCharCode(10));process.exitCode = 7;`,
  'sleep.js': `setTimeout(() => {}, 120000);`,
  'child.js': `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, [__dirname + '/sleep.js'], { detached: true, stdio: 'ignore' });
child.unref();
fs.writeFileSync(__dirname + '/grandchild.pid', String(child.pid));
setTimeout(() => {}, 120000);`,
  'noisy.js': `const chunk = Buffer.alloc(1024, 0x78);for (let i = 0; i < 200; i += 1) process.stdout.write(chunk);process.exitCode = 0;`,
  'stderr-noisy.js': `const chunk = Buffer.alloc(1024, 0x79);for (let i = 0; i < 200; i += 1) process.stderr.write(chunk);process.exitCode = 0;`,
  'flood.js': `const chunk = Buffer.alloc(${String(MIB)}, 0x7a);for (let i = 0; i < 40; i += 1) process.stdout.write(chunk);process.exitCode = 0;`,
  'flood-err.js': `const chunk = Buffer.alloc(${String(MIB)}, 0x7b);for (let i = 0; i < 40; i += 1) process.stderr.write(chunk);process.exitCode = 0;`,
  'binary.js': `process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x82]));process.exitCode = 0;`,
  'dump-env.js': `process.stdout.write(JSON.stringify(process.env));process.exitCode = 0;`,
  'dump-cwd.js': `process.stdout.write(process.cwd());process.exitCode = 0;`,
  'marker.js': `require('node:fs').writeFileSync(__dirname + '/spawned.marker', 'ran');process.exitCode = 0;`,
  'tagged-sleep.js': `require('node:fs').writeFileSync(__dirname + '/self.pid', String(process.pid));setTimeout(() => {}, 120000);`,
};

/** A trusted profile over the fixture scripts: executable + fixed argv, workspace-root cwd. */
const profileFor = (scriptDir: string, safeEnvAdditions: Readonly<Record<string, string>> = {}) => {
  const slot = (commandKey: string, script: string): unknown => ({
    commandKey,
    executable: process.execPath,
    baseArgv: [join(scriptDir, script)],
    cwd: 'workspace-root',
    safeEnvAdditions: { ...safeEnvAdditions },
  });
  const missingExecutable = {
    commandKey: 'missing',
    // A binary that does not exist at all: the executable itself cannot be started.
    executable: join(scriptDir, 'no-such-executable'),
    baseArgv: [] as string[],
    cwd: 'workspace-root',
    safeEnvAdditions: {},
  };
  return {
    missing: missingExecutable,
    tests: slot('tests', 'ok.js'),
    lint: slot('lint', 'ok.js'),
    typecheck: slot('typecheck', 'ok.js'),
    build: slot('build', 'ok.js'),
    marker: slot('marker', 'marker.js'),
    failing: slot('failing', 'fail.js'),
    sleeping: slot('sleeping', 'sleep.js'),
    spawning: slot('spawning', 'child.js'),
    noisy: slot('noisy', 'noisy.js'),
    noisyErr: slot('noisyErr', 'stderr-noisy.js'),
    flooding: slot('flooding', 'flood.js'),
    floodingErr: slot('floodingErr', 'flood-err.js'),
    binaryOut: slot('binaryOut', 'binary.js'),
    dumpEnv: slot('dumpEnv', 'dump-env.js'),
    dumpCwd: slot('dumpCwd', 'dump-cwd.js'),
  } as unknown as WorkspaceContext['commandProfile'];
};

type Registry = ReturnType<typeof createToolRegistry>;

interface Fixture {
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly manager: WorkspaceManager;
  readonly registry: Registry;
  readonly runner: RepositoryProcessRunner;
  readonly actor: string;
  readonly scriptDir: string;
  readonly casRoot: string;
  readonly invoke: (
    toolId: RepositoryProcessToolSpec['toolId'],
    input: Readonly<Record<string, unknown>>,
    actorId?: string,
  ) => Promise<Result<Readonly<Record<string, unknown>>, DomainError>>;
  readonly invokeOutcome: (
    toolId: RepositoryProcessToolSpec['toolId'],
    input: Readonly<Record<string, unknown>>,
    actorId?: string,
  ) => Promise<
    Result<{ readonly status: string; readonly output: unknown; readonly artifactRefs: readonly string[] }, DomainError>
  >;
  /** The production path for a HIGH tool: request, then an explicit human approval. */
  readonly invokeApproved: (
    toolId: RepositoryProcessToolSpec['toolId'],
    input: Readonly<Record<string, unknown>>,
  ) => Promise<Result<{ readonly status: string; readonly output: unknown }, DomainError>>;
}

interface MakeOptions {
  /** Test-only short ToolRecord timeouts (production keeps the frozen values). */
  readonly timeoutMs?: number;
  readonly safeEnvAdditions?: Readonly<Record<string, string>>;
  /** Which fixture script a trusted slot runs (a sleeping "tests" slot for timeout tests). */
  readonly slotScripts?: Readonly<Record<string, string>>;
  /**
   * Arm every deadline only once the fixture has published this file in scriptDir. A
   * timeout test must prove the kill of a process that RAN; on a loaded host Node can
   * take longer than the test deadline to reach its first line, which killed the child
   * before it ever wrote its pid (hark-ubuntu 40264045800). The deadline is still the
   * production timer path — only its start is anchored to the child's readiness.
   */
  readonly armTimersAfter?: string;
}

const make = async (options: MakeOptions = {}): Promise<Fixture> => {
  const scriptDir = tempDir();
  // Owned TEMP is now beneath this ESM repository; these reviewed fixtures use
  // require/__dirname and must retain their original CommonJS execution mode.
  writeFileSync(join(scriptDir, 'package.json'), '{"type":"commonjs"}', 'utf8');
  registerOfflineSpawnFailure(join(scriptDir, 'no-such-executable'));
  for (const [name, source] of Object.entries(SCRIPTS)) {
    writeFileSync(join(scriptDir, name), source, 'utf8');
    registerOfflineFixture(join(scriptDir, name));
  }
  const casRoot = tempDir();
  const db = openDurableDatabase({
    dataDir: tempDir(),
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'provider', 'tools'],
  });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  // The owner must exist before the tools may be registered (tool.register is authority-gated).
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  const manager = createWorkspaceManager();
  const readinessFile = options.armTimersAfter === undefined ? null : join(scriptDir, options.armTimersAfter);
  const armTimer = (ms: number, onTimeout: () => void): (() => void) => {
    if (readinessFile === null) {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    }
    let handle: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const readyBy = Date.now() + 30_000;
    const poll = (): void => {
      if (cancelled) return;
      if (existsSync(readinessFile) || Date.now() > readyBy) {
        handle = setTimeout(onTimeout, ms);
        return;
      }
      handle = setTimeout(poll, 10);
    };
    poll();
    return () => {
      cancelled = true;
      if (handle !== null) clearTimeout(handle);
    };
  };
  const runner = createRepositoryProcessRunner({
    clock,
    timer: armTimer,
    contentStore: createFilesystemArtifactContentStore({ casRoot }),
    // The registry hands `cancel` an invocation id; ToolRequest only exposed the execution
    // id, so this read-only lookup is what lets a cancellation find its process.
    resolveExecutionId: async (invocationId) => {
      const invocation = await db.toolInvocations.get(invocationId);
      return invocation === null ? null : invocation.executionId;
    },
  });
  const adapters = new Map<string, ReturnType<typeof createRepositoryProcessToolPort>>();
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    adapters.set(
      spec.toolId,
      createRepositoryProcessToolPort(spec, { workspace: () => manager.current(), clock, runner }),
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
    timer: armTimer,
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

  const run = async (
    toolId: RepositoryProcessToolSpec['toolId'],
    input: Readonly<Record<string, unknown>>,
    actorId: string,
  ): Promise<Result<{ status: string; output: unknown; artifactRefs: readonly string[] }, DomainError>> => {
    const outcome = await registry.invoke({
      toolId,
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId,
      input,
    });
    if (!outcome.ok) return outcome as Result<never, DomainError>;
    if (outcome.value.status !== 'COMPLETED') {
      return {
        ok: false as const,
        error: new DomainError('INVALID_ARGUMENT', `The invocation ended as ${outcome.value.status}.`, {
          details: { status: outcome.value.status },
        }),
      };
    }
    return ok({
      status: outcome.value.status,
      output: outcome.value.output,
      artifactRefs: outcome.value.artifactRefs,
    });
  };

  return {
    db,
    manager,
    registry,
    runner,
    actor,
    scriptDir,
    casRoot,
    invoke: (toolId, input, actorId) => run(toolId, input, actorId ?? actor),
    invokeOutcome: (toolId, input, actorId) => run(toolId, input, actorId ?? actor),
    async invokeApproved(toolId, input) {
      const listInvocations = async (): Promise<readonly { readonly id: string }[]> =>
        (await db.toolInvocations.list({ limit: 20 })).items;
      const requested = await registry.invoke({
        toolId,
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: actor,
        input,
      });
      if (requested.ok) {
        if (requested.value.status !== 'COMPLETED') {
          return {
            ok: false as const,
            error: new DomainError('INVALID_ARGUMENT', `The invocation ended as ${requested.value.status}.`, {
              details: { status: requested.value.status },
            }),
          };
        }
        return ok({ status: 'COMPLETED', output: requested.value.output });
      }
      // A HIGH tool answers APPROVAL_REQUIRED with the invocation id and runs NOTHING yet.
      if (requested.error.code !== 'APPROVAL_REQUIRED') return requested as Result<never, DomainError>;
      const invocationId = String(requested.error.details['invocationId'] ?? '');
      const stored = (await listInvocations()).find((item) => item.id === invocationId);
      expect(stored, 'the waiting invocation must be durable').toBeDefined();
      const approved = await registry.approve({ invocationId, actorId: actor });
      if (!approved.ok) return approved as Result<never, DomainError>;
      if (approved.value.status !== 'COMPLETED') {
        return {
          ok: false as const,
          error: new DomainError('INVALID_ARGUMENT', `The invocation ended as ${approved.value.status}.`, {
            details: { status: approved.value.status },
          }),
        };
      }
      return ok({ status: approved.value.status, output: approved.value.output });
    },
  };
};

const openWorkspaceWithScripts = async (
  fixture: Fixture,
  root: string,
  options: { readonly safeEnvAdditions?: Readonly<Record<string, string>>; readonly slotScripts?: Readonly<Record<string, string>> } = {},
): Promise<WorkspaceContext> => {
  const profile = profileFor(fixture.scriptDir, options.safeEnvAdditions ?? {});
  if (options.slotScripts !== undefined) {
    for (const [slot, script] of Object.entries(options.slotScripts)) {
      const current = (profile as unknown as Record<string, { baseArgv: string[] }>)[slot];
      if (current !== undefined) current.baseArgv = [join(fixture.scriptDir, script)];
    }
  }
  const opened = await fixture.manager.openWorkspace({ root, commandProfile: profile });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
};

const readCas = async (casRoot: string, ref: string): Promise<Uint8Array> =>
  createFilesystemArtifactContentStore({ casRoot }).get(ref);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until a predicate holds: process termination is asynchronous, never instantaneous. */
const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
};

const lastInvocations = async (fixture: Fixture) => (await fixture.db.toolInvocations.list({ limit: 20 })).items;

/* --------------------------------------------------- environment policy --- */

describe('RepositoryProcessEnvironmentPolicy', () => {
  it('keeps only allowlisted host keys plus the trusted additions', () => {
    const built = buildFilteredProcessEnvironment({
      platform: 'win32',
      hostEnv: {
        PATH: 'C:\\tools',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        HOME: 'C:\\Users\\x',
        HOMEPATH: '\\Users\\x',
        TEST_SECRET_TOKEN: 'super-secret-token',
      },
      safeEnvAdditions: { COMPANYOS_TEST_SAFE: 'value' },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value['PATH']).toBe('C:\\tools');
    expect(built.value['SystemRoot']).toBe('C:\\Windows');
    expect(built.value['TEMP']).toBe('C:\\Temp');
    expect(built.value['COMPANYOS_TEST_SAFE']).toBe('value');
    expect(Object.keys(built.value).sort()).toEqual(['COMPANYOS_TEST_SAFE', 'PATH', 'SystemRoot', 'TEMP']);
    // HOME / HOMEPATH / a secret are dropped, never inherited.
    expect(built.value['HOME']).toBeUndefined();
    expect(built.value['HOMEPATH']).toBeUndefined();
    expect(built.value['TEST_SECRET_TOKEN']).toBeUndefined();
  });

  it('refuses a secret-shaped trusted addition instead of publishing it', () => {
    for (const key of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'MY_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'X_CREDENTIAL']) {
      const built = buildFilteredProcessEnvironment({
        platform: 'win32',
        hostEnv: {},
        safeEnvAdditions: { [key]: 'value' },
      });
      expect(built.ok, `${key} must be refused`).toBe(false);
      if (!built.ok) expect(built.error.details['reason']).toBe('REPOSITORY_ENV_SECRET_REFUSED');
    }
  });

  it('refuses an invalid environment name or value', () => {
    const badName = buildFilteredProcessEnvironment({
      platform: 'win32',
      hostEnv: {},
      safeEnvAdditions: { 'bad name': 'v' },
    });
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error.details['reason']).toBe('REPOSITORY_ENV_NAME_INVALID');
    const badValue = buildFilteredProcessEnvironment({
      platform: 'win32',
      hostEnv: {},
      safeEnvAdditions: { GOOD: 'a\u0000b' },
    });
    expect(badValue.ok).toBe(false);
    if (!badValue.ok) expect(badValue.error.details['reason']).toBe('REPOSITORY_ENV_VALUE_INVALID');
  });
});

/* --------------------------------------------------------- tool contract --- */

describe('repository process tool contract', () => {
  it('freezes the tool ids, risks, capabilities, idempotency and timeouts', () => {
    const expected: Readonly<Record<string, { risk: 'MEDIUM' | 'HIGH'; timeout: number }>> = {
      'repo.terminal': { risk: 'HIGH', timeout: 300_000 },
      'repo.test-runner': { risk: 'MEDIUM', timeout: 600_000 },
      'repo.linter': { risk: 'MEDIUM', timeout: 300_000 },
      'repo.typechecker': { risk: 'MEDIUM', timeout: 300_000 },
      'repo.builder': { risk: 'MEDIUM', timeout: 600_000 },
    };
    expect(REPOSITORY_PROCESS_TOOL_SPECS.map((spec) => spec.toolId).sort()).toEqual(Object.keys(expected).sort());
    for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
      expect(spec.riskLevel).toBe(expected[spec.toolId]?.risk);
      expect(spec.timeoutMs).toBe(expected[spec.toolId]?.timeout);
      expect(spec.capabilities).toEqual(['side_effect']);
      expect(spec.idempotencyMode).toBe('NONE');
      expect(spec.version).toBe('1.0.0');
      const properties = Object.keys(
        (spec.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      // A QA tool takes no arguments at all; only the terminal may name a commandKey.
      expect(properties).toEqual(spec.toolId === 'repo.terminal' ? ['commandKey'] : []);
    }
  });

  it('binds each QA tool to its fixed command slot', () => {
    const slots: Readonly<Record<string, string>> = {
      'repo.test-runner': 'tests',
      'repo.linter': 'lint',
      'repo.typechecker': 'typecheck',
      'repo.builder': 'build',
    };
    for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
      if (spec.toolId === 'repo.terminal') expect(spec.slot).toBeNull();
      else expect(spec.slot).toBe(slots[spec.toolId]);
    }
  });

  it('holds no git, validator or DevCompany special case in its source', async () => {
    const { fileURLToPath } = await import('node:url');
    for (const file of [
      fileURLToPath(new URL('../../packages/engine/src/repository/repository-process-runner.ts', import.meta.url)),
      fileURLToPath(new URL('../../packages/engine/src/repository/repository-process-tools.ts', import.meta.url)),
    ]) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['repo.git', 'repo.validation-evidence', 'dev-company', 'CodeFleet', 'execSync', 'shell: true', 'shell:true']) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
      expect(source.includes('node:child_process')).toBe(file.includes('repository-process-runner'));
    }
  });
});

/* ------------------------------------------------------------- behavior --- */

describe('repository process tools on the real registry', () => {
  it('runs a trusted command and records the full success evidence', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invoke('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const output = outcome.value.output as Record<string, unknown>;
    expect(output['commandKey']).toBe('tests');
    expect(output['exitCode']).toBe(0);
    expect(output['termination']).toBe('EXITED');
    const stdout = output['stdout'] as Record<string, unknown>;
    const stderr = output['stderr'] as Record<string, unknown>;
    expect(stdout['preview']).toBe('hello stdout\n');
    expect(stderr['preview']).toBe('hello stderr\n');
    expect(stdout['byteCount']).toBe(13);
    expect(stderr['byteCount']).toBe(13);
    expect(stdout['binary']).toBe(false);
    expect(stdout['artifactRef']).toBe('');
    const invocation = (await lastInvocations(f))[0];
    expect(invocation?.status).toBe('COMPLETED');
    expect(invocation?.toolVersion).toBe('1.0.0');
    expect(invocation?.inputDigest.length).toBeGreaterThan(0);
    expect(invocation?.outputDigest).not.toBeNull();
  });

  it('never leaks the workspace root into the serialized result', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invoke('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.stringify(outcome.value)).not.toContain(root);
    expect(JSON.stringify(outcome.value)).not.toContain(f.scriptDir);
  });

  it('fails closed for the QA tools without an active workspace', async () => {
    const f = await make();
    for (const toolId of ['repo.test-runner', 'repo.linter', 'repo.typechecker', 'repo.builder'] as const) {
      const outcome = await f.invoke(toolId, {});
      expect(outcome.ok, `${toolId} must fail closed`).toBe(false);
      if (!outcome.ok) expect(outcome.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
    }
  });

  it('fails closed for the terminal without an active workspace (approval gate first)', async () => {
    const f = await make();
    const requested = await f.registry.invoke({
      toolId: 'repo.terminal',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: f.actor,
      input: { commandKey: 'tests' },
    });
    // The HIGH risk gate refuses before the adapter is reached: nothing was spawned.
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.code).toBe('APPROVAL_REQUIRED');
    expect(f.runner.activeCount()).toBe(0);
    // Approved anyway, with still no workspace: the adapter itself refuses.
    const waiting = (await lastInvocations(f)).find((item) => item.toolId === 'repo.terminal');
    expect(waiting?.status).toBe('WAITING_APPROVAL');
    const approved = await f.registry.approve({ invocationId: String(waiting?.id), actorId: f.actor });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
    expect(f.runner.activeCount()).toBe(0);
  });

  it('refuses an unknown commandKey before spawning anything', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'not-in-profile' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.details['reason']).toBe('REPOSITORY_COMMAND_NOT_ALLOWED');
      expect(JSON.stringify(outcome.error)).not.toContain(root);
    }
    expect(f.runner.activeCount()).toBe(0);
  });

  it('refuses an executable/argv/cwd/env override attempt at the input schema', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const attack = {
      commandKey: 'tests',
      executable: 'cmd.exe',
      args: ['/c', 'echo pwned'],
      cwd: 'C:\\',
      env: { SECRET: 'leak' },
    };
    // A MEDIUM QA tool reads the schema first: unknown fields are refused, nothing spawns.
    const qa = await f.invoke('repo.test-runner', attack);
    expect(qa.ok).toBe(false);
    if (!qa.ok) expect(qa.error.code).toBe('INVALID_ARGUMENT');
    expect(f.runner.activeCount()).toBe(0);
    expect(readdirSync(f.scriptDir).includes('spawned.marker')).toBe(false);
    // The HIGH terminal never even reaches its schema: the risk gate stops the same attack.
    const terminal = await f.registry.invoke({
      toolId: 'repo.terminal',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: f.actor,
      input: attack,
    });
    expect(terminal.ok).toBe(false);
    if (terminal.ok) return;
    expect(terminal.error.code).toBe('APPROVAL_REQUIRED');
    expect(f.runner.activeCount()).toBe(0);
  });

  it('refuses a QA tool that tries to name any command at all', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    for (const toolId of ['repo.test-runner', 'repo.linter', 'repo.typechecker', 'repo.builder'] as const) {
      const outcome = await f.invoke(toolId, { commandKey: 'build' });
      expect(outcome.ok, `${toolId} accepts no arguments`).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('runs each QA tool against its own fixed slot', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    for (const [toolId, expectedKey] of [
      ['repo.test-runner', 'tests'],
      ['repo.linter', 'lint'],
      ['repo.typechecker', 'typecheck'],
      ['repo.builder', 'build'],
    ] as const) {
      const outcome = await f.invoke(toolId, {});
      expect(outcome.ok, toolId).toBe(true);
      if (!outcome.ok) continue;
      expect((outcome.value.output as Record<string, unknown>)['commandKey']).toBe(expectedKey);
    }
  });

  it('runs the child in the canonical workspace root', async () => {
    const root = tempDir();
    const f = await make();
    const context = await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'dumpCwd' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stdout = (outcome.value.output as Record<string, unknown>)['stdout'] as Record<string, unknown>;
    expect(stdout['preview']).toBe(context.canonicalRoot);
  });

  it('hides parent secrets from the child and passes the trusted additions', async () => {
    const secrets: Readonly<Record<string, string>> = {
      TEST_SECRET_TOKEN: 'super-secret-token',
      TEST_PASSWORD: 'super-secret-password',
      GITHUB_TOKEN: 'ghp_fake',
      DEEPSEEK_API_KEY: 'sk-fake',
    };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(secrets)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const root = tempDir();
      const f = await make({ safeEnvAdditions: { COMPANYOS_TEST_SAFE: 'trusted-value' } });
      await openWorkspaceWithScripts(f, root, { safeEnvAdditions: { COMPANYOS_TEST_SAFE: 'trusted-value' } });
      const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'dumpEnv' });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const stdout = (outcome.value.output as Record<string, unknown>)['stdout'] as Record<string, unknown>;
      const printed = String(stdout['preview']);
      const childEnv = JSON.parse(printed) as Record<string, string>;
      for (const key of Object.keys(secrets)) {
        expect(Object.keys(childEnv)).not.toContain(key);
      }
      for (const value of Object.values(secrets)) {
        expect(printed).not.toContain(value);
      }
      expect(childEnv['COMPANYOS_TEST_SAFE']).toBe('trusted-value');
      if (typeof process.env['PATH'] === 'string') expect(typeof childEnv['PATH']).toBe('string');
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('keeps a non-zero exit a FAILED invocation that still carries its evidence', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'failing' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('PROCESS_EXIT_NONZERO');
    expect(outcome.error.details['exitCode']).toBe(7);
    const stdout = outcome.error.details['stdout'] as Record<string, unknown>;
    const stderr = outcome.error.details['stderr'] as Record<string, unknown>;
    expect(stdout['preview']).toBe('partial out\n');
    expect(stderr['preview']).toBe('failure detail\n');
    const invocation = (await lastInvocations(f))[0];
    expect(invocation?.status).toBe('FAILED');
    expect(invocation?.errorKind).toBe('TOOL_FAILED');
  });

  it('externalizes a long stdout through the existing CAS and keeps the replay bounded', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'noisy' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stdout = (outcome.value.output as Record<string, unknown>)['stdout'] as Record<string, unknown>;
    expect(stdout['byteCount']).toBe(200 * 1024);
    expect(stdout['truncated']).toBe(true);
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Buffer.from(String(stdout['preview']), 'utf8').byteLength).toBe(MAX_PROCESS_INLINE_PREVIEW_BYTES);
    const stored = await readCas(f.casRoot, String(stdout['artifactRef']));
    expect(stored.byteLength).toBe(200 * 1024);
    expect(digest(stored)).toBe(stdout['sha256']);
    // The durable replay snapshot holds bounded metadata only, never the full stream.
    const invocation = (await lastInvocations(f))[0];
    expect(JSON.stringify(invocation?.replayOutput ?? {}).length).toBeLessThan(64 * 1024);
  });

  it('externalizes a long stderr through the existing CAS', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'noisyErr' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stderr = (outcome.value.output as Record<string, unknown>)['stderr'] as Record<string, unknown>;
    expect(stderr['byteCount']).toBe(200 * 1024);
    expect(String(stderr['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = await readCas(f.casRoot, String(stderr['artifactRef']));
    expect(digest(stored)).toBe(stderr['sha256']);
  });

  it('reports binary output as binary with the full bytes externalized', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'binaryOut' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stdout = (outcome.value.output as Record<string, unknown>)['stdout'] as Record<string, unknown>;
    expect(stdout['binary']).toBe(true);
    expect(stdout['preview']).toBe('');
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = await readCas(f.casRoot, String(stdout['artifactRef']));
    expect(Array.from(stored.slice(0, 6))).toEqual([0xff, 0xfe, 0x00, 0x80, 0x81, 0x82]);
  });

  it('terminates the process tree when a stream passes the capture cap', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    for (const [commandKey, stream] of [
      ['flooding', 'stdout'],
      ['floodingErr', 'stderr'],
    ] as const) {
      const outcome = await f.invokeApproved('repo.terminal', { commandKey });
      expect(outcome.ok, `${commandKey} must fail closed`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.details['reason']).toBe('OUTPUT_LIMIT_EXCEEDED');
      const summary = outcome.error.details[stream] as Record<string, unknown>;
      expect(Number(summary['byteCount'])).toBeGreaterThan(MAX_PROCESS_CAPTURE_BYTES);
      expect(summary['truncated']).toBe(true);
    }
    expect(f.runner.activeCount()).toBe(0);
  });

  it('terminates a timed-out command and leaves no process behind', async () => {
    const root = tempDir();
    const slots = { tests: 'tagged-sleep.js' };
    const f = await make({ timeoutMs: 700, slotScripts: slots, armTimersAfter: 'self.pid' });
    await openWorkspaceWithScripts(f, root, { slotScripts: slots });
    const outcome = await f.invoke('repo.test-runner', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('TIMEOUT');
    const invocation = (await lastInvocations(f))[0];
    expect(invocation?.status).toBe('FAILED');
    expect(invocation?.errorKind).toBe('TIMEOUT');
    // The verdict is immediate, the kill is not: wait for the runner to settle and for the
    // child process itself to disappear.
    const pidFile = join(f.scriptDir, 'self.pid');
    const pidReady = await waitUntil(() => {
      try {
        return Number(readFileSync(pidFile, 'utf8')) > 0;
      } catch {
        return false;
      }
    });
    expect(pidReady).toBe(true);
    const selfPid = Number(readFileSync(pidFile, 'utf8'));
    expect(selfPid).toBeGreaterThan(0);
    expect(await waitUntil(() => !isAlive(selfPid))).toBe(true);
    expect(await waitUntil(() => f.runner.activeCount() === 0)).toBe(true);
  });

  it('cancels an in-flight command through the cancel seam', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const pending = f.invokeApproved('repo.terminal', { commandKey: 'sleeping' });
    await sleep(200);
    const invocation = (await lastInvocations(f)).find((item) => item.toolId === 'repo.terminal');
    expect(invocation).toBeDefined();
    const cancelled = await f.runner.cancel(String(invocation?.id));
    expect(cancelled.ok).toBe(true);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('PROCESS_CANCELLED');
    expect(f.runner.activeCount()).toBe(0);
  });

  it('kills the whole process tree on cancel (grandchildren included)', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const pending = f.invokeApproved('repo.terminal', { commandKey: 'spawning' });
    // Wait for the fixture to publish the grandchild pid.
    let grandchildPid = 0;
    for (let attempt = 0; attempt < 40 && grandchildPid === 0; attempt += 1) {
      await sleep(50);
      try {
        grandchildPid = Number(readFileSync(join(f.scriptDir, 'grandchild.pid'), 'utf8'));
      } catch {
        grandchildPid = 0;
      }
    }
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isAlive(grandchildPid)).toBe(true);
    const invocation = (await lastInvocations(f)).find((item) => item.toolId === 'repo.terminal');
    const cancelled = await f.runner.cancel(String(invocation?.id));
    expect(cancelled.ok).toBe(true);
    await pending;
    expect(await waitUntil(() => !isAlive(grandchildPid))).toBe(true);
    expect(await waitUntil(() => f.runner.activeCount() === 0)).toBe(true);
  });

  it('denies an invoke without the tool.invoke authority before any spawn', async () => {
    const root = tempDir();
    // The trusted "tests" slot runs the marker script: if a process ever started, it would
    // leave a file behind, so its absence is the proof that nothing spawned.
    const f = await make({ slotScripts: { tests: 'marker.js' } });
    await openWorkspaceWithScripts(f, root, { slotScripts: { tests: 'marker.js' } });
    const outcome = await f.invoke('repo.test-runner', {}, 'user_intruder');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('PERMISSION_DENIED');
    expect(readdirSync(f.scriptDir).includes('spawned.marker')).toBe(false);
    expect(f.runner.activeCount()).toBe(0);
  });

  it('holds the HIGH repo.terminal behind approval and spawns only after it', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const requested = await f.registry.invoke({
      toolId: 'repo.terminal',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: f.actor,
      input: { commandKey: 'marker' },
    });
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.code).toBe('APPROVAL_REQUIRED');
    const waiting = (await lastInvocations(f)).find((item) => item.toolId === 'repo.terminal');
    expect(waiting?.status).toBe('WAITING_APPROVAL');
    // Nothing was spawned yet: the marker only appears after a human approves.
    expect(readdirSync(f.scriptDir).includes('spawned.marker')).toBe(false);
    const approved = await f.registry.approve({ invocationId: String(waiting?.id), actorId: f.actor });
    expect(approved.ok).toBe(true);
    const after = (await lastInvocations(f)).find((item) => item.toolId === 'repo.terminal');
    expect(after?.status).toBe('COMPLETED');
    expect(readdirSync(f.scriptDir).includes('spawned.marker')).toBe(true);
  });

  it('runs the MEDIUM QA tools without approval through the existing risk policy', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeOutcome('repo.test-runner', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('COMPLETED');
    const record = await f.db.toolRecords.get('repo.test-runner');
    expect(record?.riskLevel).toBe('MEDIUM');
  });

  it('sanitizes a spawn failure to a stable code with no host path', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    const outcome = await f.invokeApproved('repo.terminal', { commandKey: 'missing' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('PROCESS_SPAWN_FAILED');
    expect(outcome.error.details['commandKey']).toBe('missing');
    expect(outcome.error.details['workspaceId']).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The failing path publishes no host path and no workspace content.
    expect(JSON.stringify(outcome.error)).not.toContain(root);
    expect(JSON.stringify(outcome.error)).not.toContain('does-not-exist.js');
    const invocation = (await lastInvocations(f))[0];
    expect(invocation?.status).toBe('FAILED');
    expect(invocation?.errorKind).toBe('TOOL_FAILED');
  });

  it('records the frozen risk level on every process tool record', async () => {
    const f = await make();
    const expected: Readonly<Record<string, string>> = {
      'repo.terminal': 'HIGH',
      'repo.test-runner': 'MEDIUM',
      'repo.linter': 'MEDIUM',
      'repo.typechecker': 'MEDIUM',
      'repo.builder': 'MEDIUM',
    };
    for (const [toolId, risk] of Object.entries(expected)) {
      const record = await f.db.toolRecords.get(toolId);
      expect(record?.riskLevel, toolId).toBe(risk);
      expect(record?.idempotencyMode, toolId).toBe('NONE');
      expect(record?.requiredAuthorities, toolId).toEqual(['tool.invoke']);
    }
  });

  it('leaves nothing in the workspace when the runner captures output', async () => {
    const root = tempDir();
    const f = await make();
    await openWorkspaceWithScripts(f, root);
    await f.invokeApproved('repo.terminal', { commandKey: 'noisy' });
    await f.invokeApproved('repo.terminal', { commandKey: 'failing' });
    expect(readdirSync(root)).toEqual([]);
  });
});

/* ------------------------------------------------- production registration --- */

describe('production repository tool set', () => {
  it('is exactly the eight Sprint 17 tools (no git, no validator yet)', async () => {
    const filesystem = await import('@companyos/engine').then((engine) => engine.REPOSITORY_TOOL_SPECS);
    const process_ = await import('@companyos/engine').then((engine) => engine.REPOSITORY_PROCESS_TOOL_SPECS);
    const registered = [...filesystem.map((spec) => spec.toolId), ...process_.map((spec) => spec.toolId)].sort();
    expect(registered).toEqual([
      'repo.builder',
      'repo.file-read',
      'repo.file-write',
      'repo.linter',
      'repo.search',
      'repo.terminal',
      'repo.test-runner',
      'repo.typechecker',
    ]);
    expect(registered).not.toContain('repo.git');
    expect(registered).not.toContain('repo.validation-evidence');
  });

  it('registers exactly that set in the desktop composition, over the shared workspace', async () => {
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/main.ts', import.meta.url)),
      'utf8',
    );
    // T17-08 corrective (superseded wiring shape, V1 Product Reachability BB-001): the
    // runtime still comes from the ONE production composition module, and main.ts only
    // delegates — but the repository-capable kinds now arrive through the ONE production
    // wiring seam (productionCompositionOptions), which declares the generic work kind
    // repository-capable. The seam module is asserted directly; core-services still owns
    // the composition. Fail-closed semantics are unchanged: without a trusted open
    // workspace, repository commands still refuse.
    expect(source.includes('composeCoreServicesImpl(')).toBe(true);
    expect(source.includes('productionCompositionOptions(')).toBe(true);
    const seam = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/production-composition.ts', import.meta.url)),
      'utf8',
    );
    // BB2 closure: the SOFTWARE work kind joins the generic kind as repository-capable.
    expect(seam.includes('repositoryCapableKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND]')).toBe(true);
    const core = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/core-services.ts', import.meta.url)),
      'utf8',
    );
    expect(core.includes('composeRepositoryRuntime({')).toBe(true);
    // Task-18-07 corrective: the repository handlers are now composed with the agent-backed
    // review/QA handlers through one trusted seam, so the assertion names that composition.
    expect(core.includes('composedStageHandlers(repositoryRuntime.handlers())')).toBe(true);
    expect(core.includes('await repositoryRuntime.registerTools(SESSION_ACTOR)')).toBe(true);
    expect(core.includes('options.repositoryRuntime?.repositoryCapableKinds ?? []')).toBe(true);
    const runtimeSource = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/repository-runtime.ts', import.meta.url)),
      'utf8',
    );
    expect(runtimeSource.split('createRepositoryProcessRunner(').length - 1).toBe(1);
    expect(runtimeSource.split('createWorkspaceManager(').length - 1).toBe(1);
    for (const forbidden of ['dev-company', 'CodeFleet']) {
      expect(core.includes(forbidden), `the composition must not mention ${forbidden}`).toBe(false);
      expect(runtimeSource.includes(forbidden), `the runtime module must not mention ${forbidden}`).toBe(false);
    }
  });
});
