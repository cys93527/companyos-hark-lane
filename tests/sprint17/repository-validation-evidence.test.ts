import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-06 — Durable QA evidence validator.
 *
 * Everything runs on the REAL ToolRegistry / ValidationService / EvidenceGuard stack over a
 * durable SQLite database, with the REAL repository tools (four QA commands, repo.git and
 * repo.validation-evidence) registered in one registry.
 *
 * The core rules proven here:
 *   - VERIFIER ONLY: the validator never executes a QA command, never spawns a process,
 *     never reads a stream (source-audited), never touches the filesystem or the network.
 *   - NON-SELECTING INPUT: a caller cannot nominate an invocation, a tool version, an
 *     expected result or an anchor; the scope comes from the trusted invocation context.
 *   - LATEST TERMINAL: an old success is never cherry-picked when a newer attempt failed.
 *   - SAME STATE: all six evidence items must share workspace, run, task, anchor; each must
 *     carry preAnchor == postAnchor; the current anchor must still equal the evidence anchor.
 *   - SAME COMMANDS: the trusted command descriptor fingerprint must still be current, so a
 *     closed/re-opened workspace whose `tests` slot points elsewhere fails the old evidence.
 *   - VERDICT vs ERROR: a FAIL is a business verdict on a COMPLETED invocation; only an
 *     infrastructure failure fails the invocation itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  REPOSITORY_VALIDATION_EVIDENCE_SPEC,
  createAuthorizationService,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createRepositoryRevisionAnchorProvider,
  createRepositoryValidationEvidencePort,
  createRepositoryValidationEvidenceRecord,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture, type GitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17val-'));
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
  id: (prefix = 'id') => `${prefix}_17M${String(++seq).padStart(10, '0')}`,
  ulid: () => `17M${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const QA_SCRIPT = `process.stdout.write('qa run' + String.fromCharCode(10));process.exit(0);`;
const FAILING_QA_SCRIPT = `process.stdout.write('failing' + String.fromCharCode(10));process.stderr.write('nope' + String.fromCharCode(10));process.exit(7);`;
const MUTATING_QA_SCRIPT = `require('node:fs').writeFileSync(process.cwd() + '/MUTATED', 'x');process.exit(0);`;

interface Harness {
  readonly db: DurableDatabase;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly repo: GitFixture;
  readonly scriptDir: string;
  readonly casRoot: string;
  readonly actor: string;
  readonly runId: string;
  readonly taskId: string;
  readonly invoke: (
    toolId: string,
    input: Readonly<Record<string, unknown>>,
    scope?: { readonly runId?: string; readonly taskId?: string },
  ) => Promise<
    | { readonly ok: true; readonly status: string; readonly invocationId: string; readonly output: unknown }
    | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> }
  >;
  /** Close and re-open the workspace, optionally with different commands/labels. */
  readonly reopen: (options?: {
    readonly testsScript?: string;
    readonly testsCommandKey?: string;
  }) => Promise<void>;
}

const makeHarness = async (
  options: {
    readonly workspaceRoot?: string;
    readonly testsScript?: string;
    /** Label the trusted `tests` descriptor with a different commandKey (a drift form). */
    readonly testsCommandKey?: string;
  } = {},
): Promise<Harness> => {
  const repo = createGitFixture();
  repo.write('a.txt', 'A\n');
  commitAll(repo, 'initial');
  const scriptDir = tempDir();
  writeFileSync(join(scriptDir, 'qa.js'), QA_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'qa.js'));
  writeFileSync(join(scriptDir, 'failing.js'), FAILING_QA_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'failing.js'));
  writeFileSync(join(scriptDir, 'mutating.js'), MUTATING_QA_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'mutating.js'));
  const casRoot = tempDir();
  const db = openDurableDatabase({
    dataDir: tempDir(),
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
  });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  const manager = createWorkspaceManager();
  const slotArgv = (script: string): string[] => [join(scriptDir, script)];
  const openWorkspace = async (testsScript: string, testsCommandKey = 'tests'): Promise<void> => {
    const opened = await manager.openWorkspace({
      root: options.workspaceRoot ?? repo.dir,
      commandProfile: {
        tests: { commandKey: testsCommandKey, executable: process.execPath, baseArgv: slotArgv(testsScript), cwd: 'workspace-root', safeEnvAdditions: {} },
        lint: { commandKey: 'lint', executable: process.execPath, baseArgv: slotArgv('qa.js'), cwd: 'workspace-root', safeEnvAdditions: {} },
        typecheck: { commandKey: 'typecheck', executable: process.execPath, baseArgv: slotArgv('qa.js'), cwd: 'workspace-root', safeEnvAdditions: {} },
        build: { commandKey: 'build', executable: process.execPath, baseArgv: slotArgv('qa.js'), cwd: 'workspace-root', safeEnvAdditions: {} },
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
  };
  await openWorkspace(options.testsScript ?? 'qa.js', options.testsCommandKey ?? 'tests');

  const runner = createRepositoryProcessRunner({
    clock,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    contentStore: undefined,
    resolveExecutionId: async (invocationId) => {
      const invocation = await db.toolInvocations.get(invocationId);
      return invocation === null ? null : invocation.executionId;
    },
  });
  const anchors = createRepositoryRevisionAnchorProvider({
    workspace: () => manager.current(),
    runner,
    gitExecutable: 'git',
    timeoutMs: 300_000,
  });
  // The trusted evidence source: a read-only query over the EXISTING table, re-projected
  // through the same store mapping the registry uses (the production selector's shape).
  const evidenceSource = {
    selectLatestTerminal: async (input: {
      readonly runId: string;
      readonly taskId: string;
      readonly toolIds: readonly string[];
    }) => {
      const placeholders = input.toolIds.map(() => '?').join(', ');
      const rows = db.db
        .prepare(
          `SELECT id FROM tool_invocations
            WHERE run_id = ? AND task_id = ? AND tool_id IN (${placeholders})
            ORDER BY created_at DESC, id DESC`,
        )
        .all(input.runId, input.taskId, ...input.toolIds) as { id: string }[];
      const invocations = [];
      for (const row of rows) {
        const found = await db.toolInvocations.get(row.id);
        if (found !== null) invocations.push(found);
      }
      return { ok: true as const, value: invocations };
    },
  };
  const toolRecordReader = {
    read: async (toolId: string) => {
      const record = await db.toolRecords.get(toolId);
      return {
        ok: true as const,
        value: record === null ? null : { version: record.version, enabled: record.enabled },
      };
    },
  };

  const adapters = new Map<string, ReturnType<typeof createRepositoryProcessToolPort>>();
  adapters.set(
    'repo.validation-evidence',
    createRepositoryValidationEvidencePort(REPOSITORY_VALIDATION_EVIDENCE_SPEC, {
      workspace: () => manager.current(),
      evidenceSource,
      toolRecords: toolRecordReader,
      anchorProvider: anchors,
      clock,
    }),
  );
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    adapters.set(
      spec.toolId,
      createRepositoryProcessToolPort(spec, {
        workspace: () => manager.current(),
        clock,
        runner,
        anchorProvider: anchors,
      }),
    );
  }
  adapters.set(
    'repo.git',
    createRepositoryGitToolPort(
      { ...REPOSITORY_GIT_TOOL_SPEC },
      {
        workspace: () => manager.current(),
        clock,
        runner,
        gitExecutable: 'git',
        timeoutMs: 300_000,
        anchorProvider: anchors,
      },
    ),
  );

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
    const record = createRepositoryProcessToolRecord(spec, nowIso());
    if (!record.ok) throw new Error(record.error.message);
    const registered = await registry.register(record.value, { actorId: actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  }
  const gitRecord = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
  if (!gitRecord.ok) throw new Error(gitRecord.error.message);
  await registry.register(gitRecord.value, { actorId: actor });
  const validatorRecord = createRepositoryValidationEvidenceRecord(
    REPOSITORY_VALIDATION_EVIDENCE_SPEC,
    nowIso(),
  );
  if (!validatorRecord.ok) throw new Error(validatorRecord.error.message);
  await registry.register(validatorRecord.value, { actorId: actor });

  const runId = ids.id('run');
  const taskId = ids.id('tsk');
  return {
    db,
    registry,
    repo,
    scriptDir,
    casRoot,
    actor,
    runId,
    taskId,
    invoke: async (toolId, input, scope) => {
      const outcome = await registry.invoke({
        toolId,
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: scope?.taskId ?? taskId,
        runId: scope?.runId ?? runId,
        actorId: actor,
        input,
        idempotencyKey: `${toolId}:${String(++seq)}:${nowIso()}`,
      });
      if (!outcome.ok) {
        return { ok: false as const, code: outcome.error.code, details: outcome.error.details };
      }
      return {
        ok: true as const,
        status: outcome.value.status,
        invocationId: outcome.value.invocationId,
        output: outcome.value.output,
      };
    },
    reopen: async (reopenOptions) => {
      manager.closeWorkspace();
      await openWorkspace(
        reopenOptions?.testsScript ?? 'qa.js',
        reopenOptions?.testsCommandKey ?? 'tests',
      );
    },
  };
};

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/** Run the four QA commands plus git status/diff in one scope. */
const produceSix = async (
  h: Harness,
  overrides: { readonly testsScript?: string } = {},
): Promise<void> => {
  const qaInput = {};
  await h.invoke('repo.test-runner', qaInput);
  await h.invoke('repo.linter', qaInput);
  await h.invoke('repo.typechecker', qaInput);
  await h.invoke('repo.builder', qaInput);
  await h.invoke('repo.git', { op: 'status' });
  await h.invoke('repo.git', { op: 'diff' });
  void overrides;
};

const validate = async (h: Harness, scope?: { readonly runId?: string; readonly taskId?: string }) =>
  h.invoke('repo.validation-evidence', { targetRef: 'artifact:art_01J0000000000000000000000', artifactId: 'art_01J0000000000000000000000', runId: h.runId }, scope);

const verdictOf = async (h: Harness, scope?: { readonly runId?: string; readonly taskId?: string }): Promise<Record<string, unknown> | null> => {
  const outcome = await validate(h, scope);
  if (!outcome.ok) throw new Error(`validator error: ${outcome.code}`);
  expect(outcome.status).toBe('COMPLETED');
  return record(outcome.output);
};

describe('repo.validation-evidence contract (T17-06)', () => {
  it('1-4. registers the exact identity: capability, risk, authority, idempotency', async () => {
    const record = createRepositoryValidationEvidenceRecord(
      REPOSITORY_VALIDATION_EVIDENCE_SPEC,
      nowIso(),
    );
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value.toolId).toBe('repo.validation-evidence');
    expect(record.value.version).toBe('1.0.0');
    expect(record.value.capabilities).toEqual(['validation:validator']);
    expect(record.value.riskLevel).toBe('LOW');
    expect(record.value.requiredAuthorities).toEqual(['tool.invoke']);
    expect(record.value.idempotencyMode).toBe('IDEMPOTENT_KEY');
  });

  it('5. offers no way to select evidence through the input', async () => {
    const h = await makeHarness();
    await produceSix(h);
    for (const spoofed of [
      { invocationIds: ['tinv_x'] },
      { testInvocationId: 'tinv_x' },
      { statusInvocationId: 'tinv_x' },
      { stdout: 'all green' },
      { anchor: { workingTreeFingerprint: 'sha256:' + '0'.repeat(64) } },
      { expectedResult: 'pass' },
      { toolVersion: '1.0.0' },
      { args: ['--all'] },
    ]) {
      const outcome = await h.invoke('repo.validation-evidence', spoofed);
      expect(outcome.ok, JSON.stringify(spoofed)).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('40. contains no process, filesystem or network surface (source audit)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    for (const file of [
      fileURLToPath(new URL('../../packages/engine/src/repository/qa-evidence.ts', import.meta.url)),
      fileURLToPath(
        new URL('../../packages/engine/src/repository/validation-evidence-tools.ts', import.meta.url)),
    ]) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of [
        'child_process',
        'spawn(',
        'execSync',
        "exec(",
        "require('node:fs')",
        "from 'node:fs'",
        'fetch(',
        'http.request',
        'https.request',
        'readFileSync',
        'writeFileSync',
      ]) {
        expect(source.includes(forbidden), `${file} must not use ${forbidden}`).toBe(false);
      }
    }
  });
});

describe('repo.validation-evidence verdicts (T17-06)', () => {
  it('11/28/29. all six current and fresh → PASS', async () => {
    const h = await makeHarness();
    await produceSix(h);
    const verdict = await verdictOf(h);
    expect(verdict).not.toBeNull();
    if (verdict === null) return;
    expect(verdict['verdict']).toBe('pass');
    expect(verdict['reasons']).toEqual([]);
    expect(verdict['missingSlots']).toEqual([]);
    expect(String(verdict['workspaceId'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Every slot carries bounded provenance and nothing else.
    const evidence = record(verdict['evidence']);
    for (const slot of ['tests', 'lint', 'typecheck', 'build', 'gitStatus', 'gitDiff']) {
      const entry = record(evidence[slot]);
      expect(String(entry['invocationId']).length, slot).toBeGreaterThan(0);
      expect(String(entry['toolVersion']), slot).toBe('1.0.0');
      expect(String(entry['status']), slot).toBe('COMPLETED');
    }
    // No command output is copied into the verdict.
    expect(JSON.stringify(verdict)).not.toContain('qa run');
    expect(JSON.stringify(verdict)).not.toContain(h.repo.dir);
  });

  it('7/70/71. a missing slot fails and is reported', async () => {
    const h = await makeHarness();
    await h.invoke('repo.test-runner', {});
    await h.invoke('repo.linter', {});
    await h.invoke('repo.typechecker', {});
    await h.invoke('repo.builder', {});
    // git baseline is NOT a substitute for status/diff.
    await h.invoke('repo.git', { op: 'baseline' });
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    expect(verdict?.['missingSlots']).toEqual(['gitStatus', 'gitDiff']);
    expect(verdict?.['reasons']).toContain('MISSING_EVIDENCE:gitStatus');
  });

  it('12/15/34. a newer FAILED attempt is never skipped in favour of an older success', async () => {
    const h = await makeHarness();
    await produceSix(h);
    // The same tests slot now fails (the trusted descriptor changes to the failing script).
    await h.reopen({ testsScript: 'failing.js' });
    await h.invoke('repo.test-runner', {});
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    // The latest terminal attempt is a failure, and the descriptor also changed.
    const tests = record(record(verdict?.['evidence'])['tests']);
    expect(tests['status']).toBe('FAILED');
    const reasons = (verdict?.['reasons'] as readonly string[] | undefined) ?? [];
    expect(reasons.some((reason) => reason.startsWith('EVIDENCE_NOT_SUCCESSFUL:tests'))).toBe(true);
  });

  it('16. tool version drift fails closed', async () => {
    const h = await makeHarness();
    await produceSix(h);
    // Re-register repo.linter at a NEW version (an immutable record cannot be edited, so the
    // store row is replaced with a higher version: drift between evidence and registration).
    const drifted = createRepositoryProcessToolRecord(
      REPOSITORY_PROCESS_TOOL_SPECS.find((spec) => spec.toolId === 'repo.linter')!,
      nowIso(),
    );
    if (!drifted.ok) throw new Error(drifted.error.message);
    await h.db.toolRecords.put({ ...drifted.value, version: '2.0.0' });
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    expect((verdict?.['reasons'] as readonly string[]) ?? []).toContain('TOOL_VERSION_DRIFT:lint');
  });

  it('17. a correct toolId with the wrong commandKey fails', async () => {
    const h = await makeHarness();
    await produceSix(h);
    // The trusted `tests` slot now runs a descriptor LABELLED differently: the toolId is
    // still repo.test-runner, but the evidence's commandKey no longer matches the slot.
    await h.reopen({ testsCommandKey: 'other-tests' });
    await h.invoke('repo.test-runner', {});
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    expect((verdict?.['reasons'] as readonly string[]) ?? []).toContain('COMMAND_KEY_MISMATCH:tests');
  });

  it('18/19/62. command descriptor drift is detected after a profile change', async () => {
    const h = await makeHarness();
    await produceSix(h);
    const before = await verdictOf(h);
    expect(before?.['verdict']).toBe('pass');
    // Close and re-open the SAME root with a DIFFERENT trusted tests command; the source is
    // byte-identical, so the anchor does not change — only the command provenance does.
    await h.reopen({ testsScript: 'mutating.js' });
    const after = await verdictOf(h);
    expect(after?.['verdict']).toBe('fail');
    expect((after?.['reasons'] as readonly string[]) ?? []).toContain('STALE_COMMAND_PROFILE:tests');
  });

  it('8. a wrong tool id never satisfies a slot', async () => {
    const h = await makeHarness();
    // Only repo.git status/diff plus three QA commands; the tests slot is filled by a
    // linter invocation instead, which must not satisfy `tests`.
    await h.invoke('repo.linter', {});
    await h.invoke('repo.typechecker', {});
    await h.invoke('repo.builder', {});
    await h.invoke('repo.git', { op: 'status' });
    await h.invoke('repo.git', { op: 'diff' });
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    expect(verdict?.['missingSlots']).toEqual(['tests']);
  });

  it('20/69. a QA command that mutated the source fails', async () => {
    const h = await makeHarness({ testsScript: 'mutating.js' });
    await produceSix(h);
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    expect((verdict?.['reasons'] as readonly string[]) ?? []).toContain('SOURCE_MUTATED_DURING_EVIDENCE:tests');
  });

  it('65/66. cross-run and cross-task evidence fails', async () => {
    const h = await makeHarness();
    await produceSix(h);
    const otherRun = await verdictOf(h, { runId: ids.id('run') });
    expect(otherRun?.['verdict']).toBe('fail');
    expect((otherRun?.['missingSlots'] as readonly string[] | undefined)?.length).toBe(6);
    const otherTask = await verdictOf(h, { taskId: ids.id('tsk') });
    expect(otherTask?.['verdict']).toBe('fail');
    expect((otherTask?.['missingSlots'] as readonly string[] | undefined)?.length).toBe(6);
  });

  it('27/35. a changed repository makes the evidence stale', async () => {
    const h = await makeHarness();
    await produceSix(h);
    expect((await verdictOf(h))?.['verdict']).toBe('pass');
    h.repo.write('a.txt', 'changed after the evidence\n');
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('fail');
    expect((verdict?.['reasons'] as readonly string[]) ?? []).toContain('STALE_EVIDENCE');
  });

  it('6. the trusted scope comes from the invocation context', async () => {
    const h = await makeHarness();
    await produceSix(h);
    const verdict = await verdictOf(h);
    expect(verdict?.['verdict']).toBe('pass');
    // The evidence slots' anchors all carry the workspace the harness opened.
    const evidence = record(verdict?.['evidence']);
    const workspaces = new Set(
      Object.values(evidence).map((slot) => String(record(record(slot)['anchor'])['workspaceId'])),
    );
    expect(workspaces.size).toBe(1);
  });

  it('32. a FAIL verdict still records a COMPLETED invocation', async () => {
    const h = await makeHarness();
    // No evidence at all.
    const outcome = await validate(h);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe('COMPLETED');
    const durable = await h.db.toolInvocations.get(outcome.invocationId);
    expect(durable?.status).toBe('COMPLETED');
    expect(durable?.toolId).toBe('repo.validation-evidence');
    expect(record(durable?.replayOutput)['verdict']).toBe('fail');
  });
});
