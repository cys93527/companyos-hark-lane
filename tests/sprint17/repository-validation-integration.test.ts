import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-06 — ValidationService / EvidenceGuard integration for
 * `repo.validation-evidence`.
 *
 * These tests use the REAL ValidationService (resolver → registry invoke → one UnitOfWork of
 * durable Validation rows + events + ledger) and the REAL EvidenceGuard, so the milestone is
 * proven end to end: six durable QA evidence items → validator → durable Validation batch →
 * EvidenceGuard accepts; a changed repository → a newer FAIL batch → EvidenceGuard denies.
 *
 * No framework semantics are changed: the validator runs through the existing invoke path with
 * the existing authority, idempotency, replay and batch rules, and the guard keeps its
 * "latest durable batch wins, no fallback to an older passing batch" behaviour.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_CAPABILITY_VALIDATOR, createArtifact, type Validation } from '@companyos/core';
import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  REPOSITORY_TOOL_SPECS,
  REPOSITORY_VALIDATION_EVIDENCE_SPEC,
  createAuthorizationService,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createRepositoryRevisionAnchorProvider,
  createRepositoryToolRecord,
  createRepositoryValidationEvidencePort,
  createRepositoryValidationEvidenceRecord,
  createToolRegistry,
  createValidationEvidenceGuard,
  createValidationService,
  createValidatorResolver,
  createWorkspaceManager,
  ensureBootstrapOwner,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17gate-'));
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
  id: (prefix = 'id') => `${prefix}_17A${String(++seq).padStart(10, '0')}`,
  ulid: () => `17A${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const QA_SCRIPT = `process.stdout.write('qa run' + String.fromCharCode(10));process.exitCode = 0;`;

interface Graph {
  readonly db: DurableDatabase;
  readonly repo: ReturnType<typeof createGitFixture>;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly validation: ReturnType<typeof createValidationService>;
  readonly guard: ReturnType<typeof createValidationEvidenceGuard>;
  readonly actor: string;
  readonly runId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly runValidation: () => Promise<readonly Validation[]>;
  readonly reopen: () => Promise<void>;
}

const STAGE_ID = 'stg_qa';

const makeGraph = async (options: { readonly dataDir?: string } = {}): Promise<Graph> => {
  const repo = createGitFixture();
  repo.write('a.txt', 'A\n');
  commitAll(repo, 'initial');
  const scriptDir = tempDir();
  writeFileSync(join(scriptDir, 'qa.js'), QA_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'qa.js'));
  const db = openDurableDatabase({
    dataDir: options.dataDir ?? tempDir(),
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
  });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  const manager = createWorkspaceManager();
  const openWorkspace = async (): Promise<void> => {
    const opened = await manager.openWorkspace({
      root: repo.dir,
      commandProfile: {
        tests: { commandKey: 'tests', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
        lint: { commandKey: 'lint', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
        typecheck: { commandKey: 'typecheck', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
        build: { commandKey: 'build', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
  };
  await openWorkspace();

  const runner = createRepositoryProcessRunner({
    clock,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
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
      const found = await db.toolRecords.get(toolId);
      return {
        ok: true as const,
        value: found === null ? null : { version: found.version, enabled: found.enabled },
      };
    },
  };

  const adapters = new Map<string, ReturnType<typeof createRepositoryProcessToolPort>>();
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
    createRepositoryGitToolPort(REPOSITORY_GIT_TOOL_SPEC, {
      workspace: () => manager.current(),
      clock,
      runner,
      gitExecutable: 'git',
      timeoutMs: 300_000,
      anchorProvider: anchors,
    }),
  );
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

  // The artifact the QA stage produces; the validator validates THAT artifact.
  const artifact = createArtifact({
    runId: ids.id('run') as never,
    taskId: ids.id('tsk') as never,
    kind: 'dev-company:qa-report',
    contentRef: 'workspace:qa-report',
    contentHash: 'c'.repeat(64),
    sizeBytes: 42,
    producedBy: 'test',
    now: nowIso(),
    ids,
  });
  if (!artifact.ok) throw new Error(artifact.error.message);
  await db.artifactStore!.create(artifact.value, {
    creationCommandId: ids.id('cmd'),
    creationCommandFingerprint: 'd'.repeat(64),
  });
  const runId = artifact.value.runId;
  const taskId = (artifact.value.taskId ?? ids.id('tsk')) as string;

  // The six durable evidence items for the same run/task.
  for (const spec of REPOSITORY_PROCESS_TOOL_SPECS) {
    await registry.invoke({
      toolId: spec.toolId,
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId,
      runId,
      actorId: actor,
      input: {},
      idempotencyKey: `evidence:${spec.toolId}:${nowIso()}:${String(++seq)}`,
    });
  }
  for (const op of ['status', 'diff'] as const) {
    await registry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId,
      runId,
      actorId: actor,
      input: { op },
      idempotencyKey: `evidence:git:${op}:${nowIso()}:${String(++seq)}`,
    });
  }

  const resolver = createValidatorResolver({ registry });
  const validation = createValidationService({
    resolver,
    artifactService: {
      create: async (command: { readonly commandId: string; readonly kind: string; readonly content: Uint8Array; readonly producedBy: string }) => {
        const made = createArtifact({
          runId: runId as never,
          taskId: taskId as never,
          kind: command.kind,
          contentRef: `command:${command.commandId}`,
          contentHash: 'e'.repeat(64),
          sizeBytes: command.content.byteLength,
          producedBy: command.producedBy,
          now: nowIso(),
          ids,
        });
        if (!made.ok) return made;
        await db.artifactStore!.create(made.value, {
          creationCommandId: command.commandId,
          creationCommandFingerprint: 'f'.repeat(64),
        });
        return { ok: true as const, value: made.value };
      },
    } as never,
    registry,
    validationStore: db.validationStore!,
    artifactStore: db.artifactStore!,
    events: db.events,
    ledger: db.ledger,
    clock,
    ids,
    unitOfWork: db.unitOfWork,
    authorize: async (input) => authz.decide(input),
  });
  const guard = createValidationEvidenceGuard({
    artifactStore: db.artifactStore!,
    validationStore: db.validationStore!,
    stagePolicy: {
      requiredValidators: async () => ({ ok: true as const, value: ['repo.validation-evidence'] }),
    },
  });

  let commandSeq = 0;
  return {
    db,
    repo,
    registry,
    validation,
    guard,
    actor,
    runId,
    stageId: STAGE_ID,
    taskId,
    runValidation: async () => {
      commandSeq += 1;
      const outcome = await validation.run({
        commandId: `cmd_validate_${String(commandSeq)}`,
        actorId: actor,
        runId,
        stageId: STAGE_ID as never,
        taskId: taskId as never,
        targetRef: `artifact:${artifact.value.id}` as never,
        validators: [{ validatorId: 'repo.validation-evidence', blocking: true }],
        traceId: `trace_validate_${String(commandSeq)}`,
      });
      if (!outcome.ok) throw new Error(`validation failed: ${outcome.error.code} ${outcome.error.message}`);
      return outcome.value;
    },
    reopen: async () => {
      manager.closeWorkspace();
      await openWorkspace();
    },
  };
};

describe('repo.validation-evidence through the real ValidationService (T17-06)', () => {
  it('58/35. records a durable PASS batch anchored to the QA artifact', async () => {
    const g = await makeGraph();
    const rows = await g.runValidation();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.validatorId).toBe('repo.validation-evidence');
    expect(row.status).toBe('pass');
    expect(row.blocking).toBe(true);
    expect(String(row.targetRef)).toMatch(/^artifact:art_[0-9A-HJKMNP-TV-Z]{10,40}$/);
    // The evidence refs are addressable: the command key plus the materialized report.
    expect(row.evidenceRefs.some((ref) => ref.startsWith('artifact:art_'))).toBe(true);
    expect(row.evidenceRefs.every((ref) => /^(artifact|command):\s*\S/.test(ref))).toBe(true);
  });

  it('60. EvidenceGuard accepts the PASS batch for the QA stage', async () => {
    const g = await makeGraph();
    await g.runValidation();
    const artifact = (await g.db.artifactStore!.listByRun(g.runId as never)).find(
      (entry) => entry.kind === 'dev-company:qa-report',
    );
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const gate = await g.guard.evaluateGate({
      runId: g.runId as never,
      stageId: g.stageId,
      artifactId: artifact.id,
      taskId: g.taskId,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.value.requiredRows).toHaveLength(1);
    expect(gate.value.requiredRows[0]!.status).toBe('pass');
  });

  it('61/56. a changed repository yields a newer FAIL batch and the guard denies', async () => {
    const g = await makeGraph();
    await g.runValidation();
    // The repository changes after the evidence was produced.
    g.repo.write('a.txt', 'changed after the evidence\n');
    const failing = await g.runValidation();
    expect(failing[0]!.status).toBe('fail');
    const artifact = (await g.db.artifactStore!.listByRun(g.runId as never)).find(
      (entry) => entry.kind === 'dev-company:qa-report',
    );
    if (artifact === undefined) return;
    const gate = await g.guard.evaluateGate({
      runId: g.runId,
      stageId: g.stageId,
      artifactId: artifact.id,
      taskId: g.taskId,
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    // Latest durable batch wins: no fallback to the older passing batch.
    expect(gate.error.details['reason']).toBe('VALIDATION_GATE_FAILED');
  });

  it('37. the validation.record authority is enforced', async () => {
    const g = await makeGraph();
    // An actor without validation.record cannot mint a batch at all.
    const denied = await g.validation.run({
      commandId: 'cmd_validate_unauthorized',
      actorId: 'user_stranger' as never,
      runId: g.runId as never,
      stageId: g.stageId as never,
      taskId: g.taskId as never,
      targetRef: `artifact:art_01J0000000000000000000000` as never,
      validators: [{ validatorId: 'repo.validation-evidence', blocking: true }],
      traceId: 'trace_unauthorized',
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('PERMISSION_DENIED');
    const batches = await g.db.validationStore!.listBatchesByTargetRef(
      `artifact:art_01J0000000000000000000000` as never,
    );
    expect(batches).toHaveLength(0);
  });

  it('74/41. a fresh service graph keeps the invocations, the batch and the guard verdict', async () => {
    const dataDir = tempDir();
    const first = await makeGraph({ dataDir });
    const rows = await first.runValidation();
    expect(rows[0]!.status).toBe('pass');
    const targetRef = String(rows[0]!.targetRef);
    first.db.close();
    openDatabases.splice(openDatabases.indexOf(first.db), 1);

    const reopened = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
    });
    openDatabases.push(reopened);
    // The six evidence invocations and the validation batch survive the restart.
    const invocations = (await reopened.toolInvocations.list({ limit: 500 })).items;
    expect(invocations.filter((entry) => entry.toolId === 'repo.test-runner')).toHaveLength(1);
    const validations = await reopened.validationStore!.listBatchesByTargetRef(targetRef as never);
    expect(validations).toHaveLength(1);
    expect(validations[0]!.validations[0]!.status).toBe('pass');
    // The report artifact the batch references is still durable and addressable.
    const reportRef = validations[0]!.validations[0]!.evidenceRefs.find((ref) => ref.startsWith('artifact:art_'));
    expect(reportRef).toBeDefined();
    if (reportRef === undefined) return;
    const report = await reopened.artifactStore!.get(reportRef.slice('artifact:'.length) as never);
    expect(report).not.toBeNull();
    expect(report?.kind).toBe('companyos/repository-qa-evidence');
    void dataDir;
  });

  it('42. the production repository registry holds exactly the ten tools', async () => {
    const g = await makeGraph();
    const records = (await g.db.toolRecords.list({ limit: 500 })).items
      .map((entry) => entry.toolId)
      .sort();
    expect(records).toEqual([
      'repo.builder',
      'repo.file-read',
      'repo.file-write',
      'repo.git',
      'repo.linter',
      'repo.search',
      'repo.terminal',
      'repo.test-runner',
      'repo.typechecker',
      'repo.validation-evidence',
    ]);
    // The validator capability is carried by the validator tool only.
    const validator = (await g.db.toolRecords.list({ limit: 500 })).items.find(
      (entry) => entry.toolId === 'repo.validation-evidence',
    );
    expect(validator?.capabilities).toContain(TOOL_CAPABILITY_VALIDATOR);
  });

  it('39. the validator never executes a QA command', async () => {
    const g = await makeGraph();
    const before = (await g.db.toolInvocations.list({ limit: 500 })).items.length;
    await g.runValidation();
    const after = (await g.db.toolInvocations.list({ limit: 500 })).items;
    // Exactly one new invocation: the validator's own. No QA command was re-run.
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]!.toolId).toBe('repo.validation-evidence');
  });
});
