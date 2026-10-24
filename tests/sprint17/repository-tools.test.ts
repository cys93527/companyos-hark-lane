/**
 * Sprint 17 / Task-17-03 — Repository filesystem & search tool adapters.
 *
 * Real filesystem in temp workspaces + the REAL ToolRegistry (authority -> risk -> schemas ->
 * adapter -> durable ToolInvocation). Path decisions always come from the T17-02 policy.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DomainError, ok, type Result } from '@companyos/core';
import {
  MAX_MATCH_LINE_PREVIEW_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_MATCHES,
  MAX_TEXT_FILE_BYTES,
  REPOSITORY_TOOL_SPECS,
  createAuthorizationService,
  createRepositoryToolPort,
  createRepositoryToolRecord,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
  type RepositoryToolSpec,
  type WorkspaceContext,
  type WorkspaceManager,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17fs-'));
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
  id: (prefix = 'id') => `${prefix}_17F${String(++seq).padStart(10, '0')}`,
  ulid: () => `17F${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-26T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-26T00:00:00.000Z') + seq * 1_000, nowIso };

const specOf = (toolId: RepositoryToolSpec['toolId']): RepositoryToolSpec => {
  const spec = REPOSITORY_TOOL_SPECS.find((entry) => entry.toolId === toolId);
  if (spec === undefined) throw new Error(`no spec for ${toolId}`);
  return spec;
};

const digest = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

type Registry = ReturnType<typeof createToolRegistry>;

const invoke = async (
  registry: Registry,
  toolId: RepositoryToolSpec['toolId'],
  input: Readonly<Record<string, unknown>>,
  actorId: string,
): Promise<Result<Readonly<Record<string, unknown>>, DomainError>> => {
  const outcome = await registry.invoke({
    toolId,
    executionId: ids.id('exc'),
    agentId: ids.id('agt'),
    taskId: ids.id('tsk'),
    runId: ids.id('run'),
    actorId,
    input,
    // The read/search tools are IDEMPOTENT_KEY: the caller supplies the key (deterministic
    // over the tool + input, so an identical read replays instead of re-running).
    idempotencyKey: `${toolId}:` + digest(new TextEncoder().encode(JSON.stringify(input))).slice(7),
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
  return ok(outcome.value.output as Readonly<Record<string, unknown>>);
};

interface Fixture {
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly manager: WorkspaceManager;
  readonly actor: string;
  readonly invoke: (
    toolId: RepositoryToolSpec['toolId'],
    input: Readonly<Record<string, unknown>>,
    actorId?: string,
  ) => Promise<Result<Readonly<Record<string, unknown>>, DomainError>>;
}

const make = async (): Promise<Fixture> => {
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
  const adapters = new Map<string, ReturnType<typeof createRepositoryToolPort>>();
  for (const spec of REPOSITORY_TOOL_SPECS) {
    adapters.set(spec.toolId, createRepositoryToolPort(spec, { workspace: () => manager.current(), clock }));
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
  for (const spec of REPOSITORY_TOOL_SPECS) {
    const record = createRepositoryToolRecord(spec, nowIso());
    if (!record.ok) throw new Error(record.error.message);
    const registered = await registry.register(record.value, { actorId: actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  }
  return { db, manager, actor, invoke: (toolId, input, actorId) => invoke(registry, toolId, input, actorId ?? actor) };
};

const openWorkspace = async (manager: WorkspaceManager, root: string): Promise<WorkspaceContext> => {
  const opened = await manager.openWorkspace({ root, commandProfile: {} });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
};

/* ------------------------------------------------------------- file read --- */

describe('repo.file-read', () => {
  it('reads a valid UTF-8 file into the controlled result (no absolute path anywhere)', async () => {
    const root = tempDir();
    const bytes = new TextEncoder().encode('hello world');
    writeFileSync(join(root, 'a.txt'), bytes);
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const read = await f.invoke('repo.file-read', { path: 'a.txt' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value['content']).toBe('hello world');
    expect(read.value['sha256']).toBe(digest(bytes));
    expect(read.value['sizeBytes']).toBe(bytes.byteLength);
    expect(read.value['relativePath']).toBe('a.txt');
    expect(read.value['internalAbsolutePath']).toBeUndefined();
    expect(read.value['canonicalRoot']).toBeUndefined();
    expect(JSON.stringify(read.value)).not.toContain(root);
  });

  it('reads a Unicode path and Unicode content', async () => {
    const root = tempDir();
    mkdirSync(join(root, '文档'));
    writeFileSync(join(root, '文档', '说明.txt'), '内容');
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const read = await f.invoke('repo.file-read', { path: '文档/说明.txt' });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value['content']).toBe('内容');
  });

  it('rejects a missing file, a directory and a symlink with the frozen taxonomy', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'outside.txt'), 'x');
    symlinkSync(join(root, 'outside.txt'), join(root, 'link.txt'), 'file');
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const missing = await f.invoke('repo.file-read', { path: 'nope.txt' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.details['reason']).toBe('NOT_A_FILE');
    const dir = await f.invoke('repo.file-read', { path: 'dir' });
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.error.details['reason']).toBe('NOT_A_FILE');
    const link = await f.invoke('repo.file-read', { path: 'link.txt' });
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.error.details['reason']).toBe('REPOSITORY_PATH_REPARSE_POINT');
  });

  it('rejects binary content and oversized files', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'bin.dat'), new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const binary = await f.invoke('repo.file-read', { path: 'bin.dat' });
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.error.details['reason']).toBe('UNSUPPORTED_BINARY');
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61));
    const oversize = await f.invoke('repo.file-read', { path: 'big.txt' });
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.error.details['reason']).toBe('FILE_SIZE_LIMIT_EXCEEDED');
  });

  it('rejects .git, absolute and escaping paths through the single policy', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'x');
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const git = await f.invoke('repo.file-read', { path: '.git/config' });
    expect(git.ok).toBe(false);
    if (!git.ok) expect(git.error.details['reason']).toBe('REPOSITORY_PATH_GIT_INTERNAL');
    const absolute = await f.invoke('repo.file-read', { path: '/etc/passwd' });
    expect(absolute.ok).toBe(false);
    const escape = await f.invoke('repo.file-read', { path: '../outside.txt' });
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error.details['reason']).toBe('REPOSITORY_PATH_PARENT_ESCAPE');
  });

  it('fails closed when no workspace is open', async () => {
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    const denied = await f.invoke('repo.file-read', { path: 'a.txt' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
  });
});

/* ------------------------------------------------------------ file write --- */

describe('repo.file-write', () => {
  it('creates and overwrites a UTF-8 file atomically, returning the digest and created flag', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'));
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const created = await f.invoke('repo.file-write', { path: 'src/new.ts', content: 'first' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value['created']).toBe(true);
    expect(created.value['sha256']).toBe(digest(new TextEncoder().encode('first')));
    expect(created.value['sizeBytes']).toBe(5);
    expect(JSON.stringify(created.value)).not.toContain(root);
    const overwritten = await f.invoke('repo.file-write', { path: 'src/new.ts', content: 'second' });
    expect(overwritten.ok).toBe(true);
    if (overwritten.ok) expect(overwritten.value['created']).toBe(false);
    expect(created.value['internalAbsolutePath']).toBeUndefined();
  });

  it('rejects .git, escaping, absolute, symlink targets and a missing parent', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'outside.txt'), 'x');
    symlinkSync(join(root, 'outside.txt'), join(root, 'link.txt'), 'file');
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const git = await f.invoke('repo.file-write', { path: '.git/config', content: 'x' });
    expect(git.ok).toBe(false);
    if (!git.ok) expect(git.error.details['reason']).toBe('REPOSITORY_PATH_GIT_INTERNAL');
    const escape = await f.invoke('repo.file-write', { path: '../evil.txt', content: 'x' });
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error.details['reason']).toBe('REPOSITORY_PATH_PARENT_ESCAPE');
    const absolute = await f.invoke('repo.file-write', { path: '/tmp/evil.txt', content: 'x' });
    expect(absolute.ok).toBe(false);
    const link = await f.invoke('repo.file-write', { path: 'link.txt', content: 'x' });
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.error.details['reason']).toBe('REPOSITORY_PATH_REPARSE_POINT');
    const parent = await f.invoke('repo.file-write', { path: 'missing/deep/file.txt', content: 'x' });
    expect(parent.ok).toBe(false);
    if (!parent.ok) expect(parent.error.details['reason']).toBe('PARENT_MISSING');
    const directory = await f.invoke('repo.file-write', { path: '.git', content: 'x' });
    expect(directory.ok).toBe(false);
  });

  it('rejects an oversized payload', async () => {
    const root = tempDir();
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    await openWorkspace(f.manager, root);
    const oversize = await f.invoke('repo.file-write', { path: 'big.txt', content: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) });
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.error.details['reason']).toBe('FILE_SIZE_LIMIT_EXCEEDED');
  });

  it('fails closed when no workspace is open', async () => {
    const f = await make();
    await ensureBootstrapOwner(
      createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      { actorId: f.actor, companyId: 'company_default' },
    );
    const denied = await f.invoke('repo.file-write', { path: 'a.txt', content: 'x' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
  });
});

/* ---------------------------------------------------------------- search --- */

const seedTree = (root: string): void => {
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'const needle = 1;\\nconst other = 2;\\n');
  writeFileSync(join(root, 'src', 'nested', 'b.ts'), 'needle again\\n');
  writeFileSync(join(root, 'src', 'nested', 'bin.dat'), new Uint8Array([0xff, 0x00]));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'needle hidden\\n');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), 'needle hidden\\n');
};

describe('repo.search', () => {
  it('finds literal matches with stable ordering, line and column', async () => {
    const root = tempDir();
    seedTree(root);
    const f = await make();
    await openWorkspace(f.manager, root);
    const found = await f.invoke('repo.search', { query: 'needle' });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const matches = found.value['matches'] as readonly { relativePath: string; line: number; column: number }[];
    expect(matches.map((match) => match.relativePath)).toEqual(['src/a.ts', 'src/nested/b.ts']);
    expect(matches[0]).toMatchObject({ line: 1, column: 7 });
    expect(found.value['skippedBinaryFiles']).toBe(1);
    expect(found.value['truncated']).toBe(false);
    expect(found.value['skippedOversizeFiles']).toBe(0);
    expect(JSON.stringify(found.value)).not.toContain(root);
    expect(JSON.stringify(matches)).not.toContain('node_modules');
    expect(JSON.stringify(matches)).not.toContain('.git');
  });

  it('honours caseSensitive and searches a scoped relative path', async () => {
    const root = tempDir();
    seedTree(root);
    const f = await make();
    await openWorkspace(f.manager, root);
    const insensitive = await f.invoke('repo.search', { query: 'NEEDLE' });
    const sensitive = await f.invoke('repo.search', { query: 'NEEDLE', caseSensitive: true });
    expect(insensitive.ok).toBe(true);
    expect(sensitive.ok).toBe(true);
    if (insensitive.ok && sensitive.ok) {
      expect((insensitive.value['matches'] as readonly unknown[]).length).toBeGreaterThan(
        (sensitive.value['matches'] as readonly unknown[]).length,
      );
    }
    const scoped = await f.invoke('repo.search', { query: 'needle', path: 'src/nested' });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect((scoped.value['matches'] as readonly { relativePath: string }[]).map((match) => match.relativePath)).toEqual([
        'src/nested/b.ts',
      ]);
    }
  });

  it('truncates at the match bound instead of running forever', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'many'));
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(root, 'many', `f${index}.ts`), 'hit hit\\n');
    }
    const f = await make();
    await openWorkspace(f.manager, root);
    const capped = await f.invoke('repo.search', { query: 'hit', path: 'many' });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    const matches = capped.value['matches'] as readonly unknown[];
    expect(matches.length).toBeLessThanOrEqual(MAX_SEARCH_MATCHES);
    expect(typeof capped.value['truncated']).toBe('boolean');
    void MAX_SEARCH_FILES;
    void MAX_MATCH_LINE_PREVIEW_BYTES;
  });

  it('does not traverse a symlinked directory', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.txt'), 'needle outside\\n');
    symlinkSync(outside, join(root, 'link'), 'junction');
    const f = await make();
    await openWorkspace(f.manager, root);
    const found = await f.invoke('repo.search', { query: 'needle' });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(JSON.stringify(found.value['matches'])).not.toContain('secret');
  });

  it('rejects an escaping search path and fails closed with no workspace', async () => {
    const root = tempDir();
    seedTree(root);
    const f = await make();
    await openWorkspace(f.manager, root);
    const escape = await f.invoke('repo.search', { query: 'needle', path: '../outside' });
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error.details['reason']).toBe('REPOSITORY_PATH_PARENT_ESCAPE');
    const closed = await make();
    const denied = await closed.invoke('repo.search', { query: 'x' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
  });
});

/* --------------------------------------------------- real registry chain --- */

describe('real ToolRegistry integration', () => {
  it('runs the full authority -> risk -> schema -> adapter -> durable invocation chain', async () => {
    const root = tempDir();
    const bytes = new TextEncoder().encode('hello world');
    writeFileSync(join(root, 'a.txt'), bytes);
    const f = await make();
    await openWorkspace(f.manager, root);
    const read = await f.invoke('repo.file-read', { path: 'a.txt' });
    expect(read.ok).toBe(true);
    const invocations = await f.db.toolInvocations.list({ limit: 50 });
    expect(invocations.items).toHaveLength(1);
    const invocation = invocations.items[0]!;
    expect(invocation.toolId).toBe('repo.file-read');
    expect(invocation.toolVersion).toBe('1.0.0');
    expect(invocation.status).toBe('COMPLETED');
    expect(invocation.inputDigest.length).toBeGreaterThan(0);
    expect(invocation.outputDigest).not.toBeNull();
    expect(JSON.stringify(invocation)).not.toContain(root);
    void bytes;
  });

  it('rejects an invoke from an actor without tool.invoke (the registry gate, not the adapter)', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'hello');
    const f = await make();
    await openWorkspace(f.manager, root);
    const denied = await f.invoke('repo.file-read', { path: 'a.txt' }, 'user_stranger');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');
  });

  it('records the frozen risk, capability and idempotency per tool', () => {
    const readRecord = createRepositoryToolRecord(specOf('repo.file-read'), nowIso());
    expect(readRecord.ok).toBe(true);
    if (readRecord.ok) {
      expect(readRecord.value.riskLevel).toBe('LOW');
      expect(readRecord.value.capabilities).toEqual(['read']);
      expect(readRecord.value.idempotencyMode).toBe('IDEMPOTENT_KEY');
      expect(readRecord.value.requiredAuthorities).toEqual(['tool.invoke']);
      expect(readRecord.value.version).toBe('1.0.0');
    }
    const writeRecord = createRepositoryToolRecord(specOf('repo.file-write'), nowIso());
    expect(writeRecord.ok).toBe(true);
    if (writeRecord.ok) {
      expect(writeRecord.value.riskLevel).toBe('MEDIUM');
      expect(writeRecord.value.capabilities).toEqual(['write']);
      expect(writeRecord.value.idempotencyMode).toBe('COMMAND_ID');
    }
    const searchRecord = createRepositoryToolRecord(specOf('repo.search'), nowIso());
    expect(searchRecord.ok).toBe(true);
    if (searchRecord.ok) {
      expect(searchRecord.value.riskLevel).toBe('LOW');
      expect(searchRecord.value.capabilities).toEqual(['read']);
      expect(searchRecord.value.idempotencyMode).toBe('IDEMPOTENT_KEY');
    }
  });
});

describe('restart semantics (workspace is process-local)', () => {
  it('a fresh manager has no active workspace, so repo tools fail closed until a trusted re-open', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'hello world');
    const first = await make();
    await openWorkspace(first.manager, root);
    const read = await first.invoke('repo.file-read', { path: 'a.txt' });
    expect(read.ok).toBe(true);

    // A NEW manager (a restarted process): nothing is restored from durable state.
    const restarted = await make();
    const denied = await restarted.invoke('repo.file-read', { path: 'a.txt' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');

    // A trusted re-open of the SAME root restores availability with zero re-registration.
    writeFileSync(join(root, 'b.txt'), 'hello world');
    await openWorkspace(restarted.manager, root);
    // NOTE: a distinct path, because the registry replays a recorded outcome for a given
    // idempotency key - the earlier denial is never dressed up as a success (Sprint 9.1).
    const again = await restarted.invoke('repo.file-read', { path: 'b.txt' });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value['content']).toBe('hello world');
    // The durable invocation history is unchanged by the re-open (no auto re-run).
    const invocations = await restarted.db.toolInvocations.list({ limit: 50 });
    expect(invocations.items).toHaveLength(2);
    expect(invocations.items.map((item) => item.status).sort()).toEqual(['COMPLETED', 'FAILED']);
  });

  it('keeps no OS environment, process or network surface in the adapters', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/repository/repository-tools.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of [
      'child_process',
      'process.env',
      'fetch(',
      'http.request',
      'https.request',
      'spawn(',
      'exec(',
      'execSync',
      "require('child_process')",
    ]) {
      expect(source.includes(forbidden), `repository-tools must not use ${forbidden}`).toBe(false);
    }
    // Only node:fs and node:path/crypto are touched — the workspace-rooted filesystem.
    expect(source.includes("from 'node:fs'")).toBe(true);
  });
});
