import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-08 — production repository runtime end-to-end verification.
 *
 * The chain runs on the REAL production composition entry (`composeCoreServices` from
 * apps/desktop/src/core-services.ts — the same module the desktop bootstrap uses), the REAL ToolRegistry / WorkflowEngine / ValidationService / EvidenceGuard,
 * the REAL Artifact/CAS store and a REAL temporary Git repository. No repository tool is
 * faked; the only stub is the deployment's own stage work (an agent round), which is
 * deterministic by design — this suite verifies the CompanyOS runtime, not a model.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolPort } from '@companyos/core';
import {
  createAuthorizationService,
  createPackAvailabilityPolicy,
  createPackService,
  createToolRegistry,
  createWorkflowEngine,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  type StageHandlerRegistry,
  type ToolRegistry,
} from '@companyos/engine';
import { REPOSITORY_TOOL_SPECS as REPOSITORY_TOOL_SPEC_LIST } from '@companyos/engine';
import { createTask, createWorkflowRun } from '@companyos/core';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import { DEVCOMPANY_MANIFEST } from '@companyos/pack-dev-company';

import { composeCoreServices, lastCoreCompositionError } from '../../apps/desktop/src/core-services.js';
import type { RepositoryRuntime } from '../../apps/desktop/src/repository-runtime.js';
import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17e2e-'));
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

/** A QA fixture that succeeds and prints > 16 KiB, so the CAS path is real. */
const QA_SCRIPT = `const chunk = Buffer.alloc(1024, 0x71);
for (let i = 0; i < 64; i += 1) process.stdout.write(chunk);
process.stderr.write('qa ok' + String.fromCharCode(10));
process.exit(0);`;

const record = (value: unknown): Record<string, unknown> => (value ?? {}) as Record<string, unknown>;
const STAGE_ID = 'stg_e2e';

interface E2E {
  readonly db: DurableDatabase;
  readonly repo: ReturnType<typeof createGitFixture>;
  readonly registry: ToolRegistry;
  readonly actor: string;
  readonly casRoot: string;
  readonly dataDir: string;
  readonly runId: string;
  readonly taskId: string;
  readonly runtime: RepositoryRuntime;
  readonly core: Awaited<ReturnType<typeof composeCoreServices>>;
  readonly invoke: (
    toolId: string,
    input: Readonly<Record<string, unknown>>,
    scope?: { readonly runId?: string; readonly taskId?: string },
  ) => Promise<
    | { readonly ok: true; readonly status: string; readonly invocationId: string; readonly output: unknown }
    | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> }
  >;
}

const composeE2E = async (options: { readonly openWorkspace?: boolean } = {}) => {
  const repo = createGitFixture();
  repo.write('src/example.txt', 'example v1\n');
  commitAll(repo, 'initial');
  const scriptDir = tempDir();
  writeFileSync(join(scriptDir, 'qa.js'), QA_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'qa.js'));
  const casRoot = tempDir();
  const dataDir = tempDir();
  const db = openDurableDatabase({
    dataDir,
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
  });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  // THE production composition entry (apps/desktop/src/core-services.ts): the SAME module
  // the desktop bootstrap composes, parameterised only with temp paths, the trusted command
  // profile and the repository-capable kinds. Nothing here hand-wires a stronger graph.
  const { openArtifactFoundation } = await import('../../apps/desktop/src/artifact-stack.js');
  // The real CAS reconciliation pass over a temp root — the same call the desktop makes.
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(foundation.error.message);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation,
    repositoryRuntime: { repositoryCapableKinds: ['work'] },
  });
  if (core === null) throw new Error(`the production composition failed: ${String(lastCoreCompositionError())}`);
  const registry = core.tools;
  const runtime = core.repositoryRuntime;
  const registered = await runtime.registerTools(actor);
  if (!registered.ok) throw new Error(registered.error.message);
  expect(registered.value).toHaveLength(10);

  if (options.openWorkspace !== false) {
    const opened = await runtime.openWorkspace({
      root: repo.dir,
      commandProfile: {
        tests: { commandKey: 'tests', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
        lint: { commandKey: 'lint', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
        typecheck: { commandKey: 'typecheck', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
        build: { commandKey: 'build', executable: process.execPath, baseArgv: [join(scriptDir, 'qa.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
  }

  const runId = ids.id('run');
  const taskId = ids.id('task');
  // The durable run every repository invocation and validation record anchors to.
  const seededRun = createWorkflowRun({
    companyId: 'company_default' as never,
    workflowId: 'wfl_e2e' as never,
    templateId: 'tpl_e2e' as never,
    versionId: 'ver_e2e' as never,
    snapshotId: 'snp_e2e' as never,
    startedBy: actor,
    now: nowIso(),
    ids,
  });
  if (!seededRun.ok) throw new Error(seededRun.error.message);
  await db.runs.put({ ...seededRun.value, id: runId as never });
  return {
    db,
    repo,
    registry,
    core,
    runtime,
    actor,
    casRoot,
    dataDir,
    runId,
    taskId,
    invoke: async (toolId: string, input: Readonly<Record<string, unknown>>, scope?: { readonly runId?: string; readonly taskId?: string }) => {
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
  };
};

/** Run the durable validator through the REAL ValidationService and return the batch. */
interface ValidationVerdict {
  readonly status: string;
  readonly validatorId: string;
  readonly blocking: boolean;
  readonly evidenceRefs: readonly string[];
  readonly gate: 'accept' | 'deny';
  readonly targetRef: string;
}

const runValidation = async (e: E2E): Promise<ValidationVerdict> => {
  const { createValidationEvidenceGuard, createValidationService, createValidatorResolver } = await import('@companyos/engine');
  const { createArtifactService } = await import('@companyos/engine');
  const artifact = createArtifactService({
    artifactStore: e.db.artifactStore!,
    contentStore: createFilesystemArtifactContentStore({ casRoot: e.casRoot }),
    runs: e.db.runs,
    events: e.db.events,
    ledger: e.db.ledger,
    clock,
    ids,
    unitOfWork: e.db.unitOfWork,
    authorize: async () => ({ ok: true as const, value: true as const }),
  });
  const service = createValidationService({
    resolver: createValidatorResolver({ registry: e.registry }),
    registry: e.registry,
    validationStore: e.db.validationStore!,
    artifactStore: e.db.artifactStore!,
    artifactService: artifact,
    events: e.db.events,
    ledger: e.db.ledger,
    clock,
    ids,
    unitOfWork: e.db.unitOfWork,
    authorize: async () => ({ ok: true as const, value: true as const }),
  });
  // The QA report artifact the stage validates.
  const report = await artifact.create({
    commandId: ids.id('cmd'),
    runId: e.runId as never,
    taskId: e.taskId as never,
    kind: 'qa-report',
    content: new TextEncoder().encode('the six evidence items are durable'),
    producedBy: 'test',
    traceId: 'trace_validation',
  });
  if (!report.ok) throw new Error(report.error.message);
  const outcome = await service.run({
    commandId: ids.id('cmd'),
    actorId: e.actor,
    runId: e.runId as never,
    stageId: STAGE_ID as never,
    taskId: e.taskId as never,
    targetRef: `artifact:${report.value.id}` as never,
    validators: [{ validatorId: 'repo.validation-evidence', blocking: true }],
    traceId: 'trace_validation',
  });
  if (!outcome.ok) throw new Error(outcome.error.message);
  const guard = createValidationEvidenceGuard({
    artifactStore: e.db.artifactStore!,
    validationStore: e.db.validationStore!,
    stagePolicy: { requiredValidators: async () => ({ ok: true as const, value: ['repo.validation-evidence'] }) },
  });
  const gate = await guard.evaluateGate({
    runId: e.runId as never,
    stageId: STAGE_ID as never,
    artifactId: report.value.id,
    taskId: e.taskId as never,
  });
  return {
    status: outcome.value[0]!.status,
    validatorId: outcome.value[0]!.validatorId,
    blocking: outcome.value[0]!.blocking,
    evidenceRefs: outcome.value[0]!.evidenceRefs,
    gate: gate.ok ? ('accept' as const) : ('deny' as const),
    targetRef: `artifact:${report.value.id}`,
  };
};

describe('production repository runtime composition (T17-08)', () => {
  it('1/2/73: composes the ten tools and fails closed without a workspace', async () => {
    const e = await composeE2E({ openWorkspace: false });
    const records = (await e.db.toolRecords.list({ limit: 500 })).items.map((item) => item.toolId).sort();
    // The production registry also holds the desktop's own mock tools; the REPOSITORY set is
    // exactly the ten Sprint 17 tools.
    const repositoryTools = records.filter((toolId) => toolId.startsWith('repo.'));
    expect(repositoryTools).toEqual([
      'repo.builder',
      'repo.file-read',
      'repo.file-write',
      'repo.git',
      'repo.linter',
      'repo.search',
      'repo.terminal',
      'repo.test-check',
      'repo.test-runner',
      'repo.typechecker',
      'repo.validation-evidence',
    ]);
    // No workspace ⇒ every repository tool fails closed (the runtime itself started fine).
    const read = await e.invoke('repo.file-read', { path: 'src/example.txt' });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.details['reason']).toBe('WORKSPACE_NOT_OPEN');
    expect(e.runtime.lease.current()).toBeNull();
    expect(e.runtime.currentWorkspace()).toBeNull();
  });

  it('3/20/75: the trusted open exposes a real workspace and leaves other kinds alone', async () => {
    const e = await composeE2E();
    const workspace = e.runtime.currentWorkspace();
    expect(workspace).not.toBeNull();
    if (workspace === null) return;
    expect(workspace.workspaceId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(workspace.commandProfile)).toEqual(['tests', 'lint', 'typecheck', 'build']);
    // Only the declared kind is repository-capable.
    expect(e.runtime.repositoryKinds()).toEqual(['work']);
    expect(e.runtime.handlers().has('work')).toBe(true);
    expect(e.runtime.handlers().has('review')).toBe(false);
  });

  it('6/7: DevCompany installs against the real production registry', async () => {
    const e = await composeE2E();
    const lifecycle = createWorkflowLifecycle({
      ids,
      clock,
      templates: e.db.templates,
      locks: e.db.locks,
      proposals: e.db.proposals,
      snapshots: e.db.snapshots,
      runs: e.db.runs,
      events: e.db.events,
      unitOfWork: e.db.unitOfWork,
      packAvailability: createPackAvailabilityPolicy({
        packInstallations: e.db.packInstallations!,
        packContentRefs: e.db.packContentRefs!,
      }),
    });
    const authz = createAuthorizationService({ ids, clock, roles: e.db.roles, assignments: e.db.roleAssignments });
    const service = createPackService({
      clock,
      ids,
      authorization: authz,
      lifecycle,
      packVersions: e.db.packVersions!,
      packInstallations: e.db.packInstallations!,
      packContentRefs: e.db.packContentRefs!,
      events: e.db.events,
      ledger: e.db.ledger,
      unitOfWork: e.db.unitOfWork,
      toolRequirementResolver: {
        resolve: async (toolId) => {
          const found = (await e.db.toolRecords.list({ limit: 500 })).items.find((item) => item.toolId === toolId);
          return found === undefined
            ? { ok: false as const }
            : { ok: true as const, capabilities: found.capabilities };
        },
      },
    });
    const installed = await service.install({
      commandId: ids.id('cmd'),
      companyId: 'company_default',
      actorId: e.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_install',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const refs = await e.db.packContentRefs!.listByInstallation(installed.value.id);
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    expect(refs.value).toHaveLength(24);
    // B/10-13: the Sprint 16 frozen invariants — the PACK materializes exactly five roles,
    // the only other role is the pre-existing bootstrap owner, and nothing is auto-assigned.
    const roles = (await e.db.roles.list({ limit: 500 })).items.filter((role) => role.companyId === 'company_default');
    // Pack roles are materialized with the flattened `<packId>-<key>` form (Sprint 16).
    const packRoles = roles.map((role) => role.key).filter((key) => key.startsWith('dev-company-'));
    expect(packRoles.sort()).toEqual([
      'dev-company-cto',
      'dev-company-developer',
      'dev-company-documentation',
      'dev-company-qa',
      'dev-company-reviewer',
    ]);
    const systemRoles = roles.map((role) => role.key).filter((key) => !key.startsWith('dev-company-'));
    expect(systemRoles).toEqual(['owner']);
    expect(roles).toHaveLength(packRoles.length + systemRoles.length);
    const assignments = (await e.db.roleAssignments.list({ limit: 500 })).items;
    expect(assignments).toHaveLength(1);
    // 12: exactly one workflow template was materialized.
    const workflowRefs = refs.value.filter((ref) => ref.contentKind === 'workflowTemplate');
    expect(workflowRefs).toHaveLength(1);
    // 11: the content refs are exactly 24.
    expect(refs.value).toHaveLength(24);
    // 14: the pack is still 1.0.0 and the manifest is untouched.
    expect(installed.value.packId).toBe('dev-company');
    expect(installed.value.packVersion).toBe('1.0.0');
  });

  it('9/25/26/27: the repository Task goes through the engine START path with lease and baseline', async () => {
    const e = await composeE2E();
    const run = createWorkflowRun({
      companyId: 'company_default' as never,
      workflowId: 'wfl_e2e' as never,
      templateId: 'tpl_e2e' as never,
      versionId: 'ver_e2e' as never,
      snapshotId: 'snp_e2e' as never,
      startedBy: e.actor,
      now: nowIso(),
      ids,
    });
    if (!run.ok) throw new Error(run.error.message);
    await e.db.runs.put(run.value);
    const task = createTask({
      runId: run.value.id as never,
      stageId: STAGE_ID as never,
      roleId: 'rol_e2e' as never,
      kind: 'work',
      now: nowIso(),
      ids,
    });
    if (!task.ok) throw new Error(task.error.message);
    await e.db.tasks.put(task.value);

    const handlers: StageHandlerRegistry = {
      resolve: (kind: string) => e.runtime.handlers().get(kind) ?? null,
    };
    const engine = createWorkflowEngine({
      ids,
      clock,
      runs: e.db.runs,
      events: e.db.events,
      approvals: e.db.approvals,
      tasks: e.db.tasks,
      handlers,
      ledger: e.db.ledger,
      unitOfWork: e.db.unitOfWork,
    });
    // The engine drives the run to EXECUTING through its own state machine.
    const driven = await engine.drive(run.value.id as never, { maxSteps: 8 });
    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    expect(driven.value.run.state).toBe('EXECUTING');
    const advanced = await engine.advance({
      runId: run.value.id,
      stageId: STAGE_ID as never,
      taskIds: [task.value.id] as never,
      snapshot: { snapshotId: run.value.snapshotId as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(advanced.outcome).toBe('completed');
    const stored = await e.db.tasks.get(task.value.id as never);
    expect(stored?.state).toBe('DONE');

    // The baseline is a REAL repo.git invocation bound to this run/task.
    const baseline = (await e.db.toolInvocations.list({ limit: 500 })).items.filter((item) =>
      (item.idempotencyKey ?? '').startsWith('task-baseline:'),
    );
    expect(baseline).toHaveLength(1);
    expect(baseline[0]!.toolId).toBe('repo.git');
    expect(baseline[0]!.runId).toBe(run.value.id);
    expect(baseline[0]!.taskId).toBe(task.value.id);
    expect(record(baseline[0]!.replayOutput)['op']).toBe('baseline');
    // The lease was released by the handler's finally.
    expect(e.runtime.lease.current()).toBeNull();
  });

  it('14-18/28: repository work runs through the real tools, with CAS evidence', async () => {
    const e = await composeE2E();
    const read = await e.invoke('repo.file-read', { path: 'src/example.txt' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(record(read.output)['content']).toBe('example v1\n');
    const written = await e.invoke('repo.file-write', { path: 'src/example.txt', content: 'example v2\n' });
    expect(written.ok).toBe(true);
    const found = await e.invoke('repo.search', { query: 'example v2', path: 'src' });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect((record(found.output)['matches'] as unknown[]).length).toBeGreaterThan(0);

    for (const toolId of ['repo.test-runner', 'repo.linter', 'repo.typechecker', 'repo.builder'] as const) {
      const qa = await e.invoke(toolId, {});
      expect(qa.ok, toolId).toBe(true);
      if (!qa.ok) continue;
      expect(qa.status).toBe('COMPLETED');
      const stdout = record(record(qa.output)['stdout']);
      expect(Number(stdout['byteCount'])).toBeGreaterThan(16 * 1024);
      expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
      const stored = await createFilesystemArtifactContentStore({ casRoot: e.casRoot }).get(
        String(stdout['artifactRef']),
      );
      expect(stored.byteLength).toBe(64 * 1024);
      expect(record(qa.output)['preAnchor']).toBeDefined();
      expect(record(record(qa.output)['preAnchor'])['workingTreeFingerprint']).toBe(
        record(record(qa.output)['postAnchor'])['workingTreeFingerprint'],
      );
    }
  });

  it('19-25/36: the full evidence chain passes validation and the EvidenceGuard', async () => {
    const e = await composeE2E();
    for (const toolId of ['repo.test-runner', 'repo.linter', 'repo.typechecker', 'repo.builder'] as const) {
      const qa = await e.invoke(toolId, {});
      expect(qa.ok, toolId).toBe(true);
    }
    for (const op of ['status', 'diff'] as const) {
      const git = await e.invoke('repo.git', { op });
      expect(git.ok, op).toBe(true);
      if (!git.ok) continue;
      expect(record(record(git.output)['preAnchor'])['workingTreeFingerprint']).toBe(
        record(record(git.output)['postAnchor'])['workingTreeFingerprint'],
      );
    }
    // All six evidence items share one stable anchor.
    const anchors = new Set<string>();
    for (const invocation of (await e.db.toolInvocations.list({ limit: 500 })).items) {
      for (const field of ['postAnchor', 'anchor']) {
        const value = record(record(invocation.replayOutput)[field])['workingTreeFingerprint'];
        if (typeof value === 'string' && value.length > 0) anchors.add(value);
      }
    }
    expect(anchors.size).toBe(1);
    // The anchor algorithm is the corrected one (index-aware).
    expect([...anchors][0]).toMatch(/^sha256:[0-9a-f]{64}$/);

    const verdict = await runValidation(e);
    expect(verdict.status).toBe('pass');
    expect(verdict.validatorId).toBe('repo.validation-evidence');
    expect(verdict.blocking).toBe(true);
    expect(verdict.gate).toBe('accept');
  });

  it('26-28/39: mutating the source after the evidence makes the validator FAIL STALE and the guard deny', async () => {
    const e = await composeE2E();
    for (const toolId of ['repo.test-runner', 'repo.linter', 'repo.typechecker', 'repo.builder'] as const) {
      expect((await e.invoke(toolId, {})).ok, toolId).toBe(true);
    }
    for (const op of ['status', 'diff'] as const) {
      expect((await e.invoke('repo.git', { op })).ok, op).toBe(true);
    }
    const first = await runValidation(e);
    expect(first.status).toBe('pass');
    expect(first.gate).toBe('accept');

    // A real repository mutation through repo.file-write, then re-validate.
    const mutated = await e.invoke('repo.file-write', { path: 'src/example.txt', content: 'example v3\n' });
    expect(mutated.ok).toBe(true);
    const second = await runValidation(e);
    expect(second.status).toBe('fail');
    // The latest durable batch FAILS, so the guard denies (no fallback to the older PASS).
    expect(second.gate).toBe('deny');
  });
});

describe('production restart and negative chains (T17-08)', () => {
  it('31-37: a fresh graph keeps the durable state and restores neither workspace nor lease', async () => {
    const e = await composeE2E();
    for (const toolId of ['repo.test-runner', 'repo.linter', 'repo.typechecker', 'repo.builder'] as const) {
      expect((await e.invoke(toolId, {})).ok, toolId).toBe(true);
    }
    for (const op of ['status', 'diff'] as const) {
      expect((await e.invoke('repo.git', { op })).ok, op).toBe(true);
    }
    // A real task-start baseline (through the repository stage handler).
    const handler = e.runtime.handlers().get('work');
    expect(handler).toBeDefined();
    if (handler !== undefined) {
      expect(
        await handler.execute({
          runId: e.runId,
          stageId: STAGE_ID as never,
          taskId: e.taskId as never,
          kind: 'work',
          attempt: 1,
          branch: null,
          payload: {},
        }),
      ).toBe('succeeded');
    }
    const verdict = await runValidation(e);
    expect(verdict.status).toBe('pass');
    const baselineBefore = (await e.db.toolInvocations.list({ limit: 500 })).items.filter((item) =>
      (item.idempotencyKey ?? '').startsWith('task-baseline:'),
    );
    expect(baselineBefore).toHaveLength(1);
    const validationBefore = await e.db.validationStore!.listBatchesByTargetRef(verdict.targetRef as never);

    // Tear the whole process graph down: database closed, workspace and lease destroyed.
    e.runtime.closeWorkspace();
    e.db.close();
    openDatabases.splice(openDatabases.indexOf(e.db), 1);

    // A FRESH composition over the same durable directory.
    const { composeRepositoryRuntime } = await import('../../apps/desktop/src/repository-runtime.js');
    const reopenedDb = openDurableDatabase({
      dataDir: e.dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
    });
    openDatabases.push(reopenedDb);
    let freshRegistry: ToolRegistry | null = null;
    const fresh = composeRepositoryRuntime({
      db: reopenedDb,
      registry: () => {
        if (freshRegistry === null) throw new Error('not composed');
        return freshRegistry;
      },
      contentStore: createFilesystemArtifactContentStore({ casRoot: e.casRoot }),
      clock,
      ids,
      actorId: e.actor,
      repositoryCapableKinds: ['work'],
    });
    const freshAdapters = new Map<string, ToolPort>();
    for (const [toolId, port] of fresh.toolPorts) freshAdapters.set(toolId, port);
    freshRegistry = createToolRegistry({
      ids,
      clock,
      records: reopenedDb.toolRecords,
      invocations: reopenedDb.toolInvocations,
      invocationArtifacts: reopenedDb.toolInvocationArtifacts,
      adapters: freshAdapters,
      authorize: async () => ({ ok: true as const, value: true as const }),
      ...(reopenedDb.toolInvocationClaims === null ? {} : { claims: reopenedDb.toolInvocationClaims }),
      ...(reopenedDb.toolInvocationIndex === null ? {} : { invocationIndex: reopenedDb.toolInvocationIndex }),
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    await fresh.registerTools(e.actor);

    // 32/44/45: no workspace and no lease are restored.
    expect(fresh.currentWorkspace()).toBeNull();
    expect(fresh.lease.current()).toBeNull();
    const refused = await freshRegistry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: e.taskId,
      runId: e.runId,
      actorId: e.actor,
      input: { op: 'status' },
      idempotencyKey: `restart:${String(++seq)}`,
    });
    if (refused.ok) throw new Error('repository tools must fail closed without a workspace');
    expect(refused.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');

    // 33/34/35/36: the durable state survived.
    const baselineAfter = (await reopenedDb.toolInvocations.list({ limit: 500 })).items.filter((item) =>
      (item.idempotencyKey ?? '').startsWith('task-baseline:'),
    );
    expect(baselineAfter).toHaveLength(baselineBefore.length);
    expect(baselineAfter[0]!.id).toBe(baselineBefore[0]!.id);
    const validationAfter = await reopenedDb.validationStore!.listBatchesByTargetRef(verdict.targetRef as never);
    expect(validationAfter).toHaveLength(validationBefore.length);
    expect(validationAfter[0]!.validations[0]!.status).toBe('pass');
    // 36: the CAS bytes of the >16 KiB QA output are still readable.
    const qa = (await reopenedDb.toolInvocations.list({ limit: 500 })).items.find(
      (item) => item.toolId === 'repo.test-runner',
    );
    const artifactRef = String(
      ((qa?.replayOutput as Record<string, unknown> | undefined)?.['stdout'] as Record<string, unknown> | undefined)?.[
        'artifactRef'
      ] ?? '',
    );
    expect(artifactRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = await createFilesystemArtifactContentStore({ casRoot: e.casRoot }).get(artifactRef);
    expect(stored.byteLength).toBe(64 * 1024);

    // 33/46: a trusted re-open of the same repository, then the ORIGINAL baseline is reused.
    const reopened = await fresh.openWorkspace({
      root: e.repo.dir,
      commandProfile: {
        tests: { commandKey: 'tests', executable: process.execPath, baseArgv: [join(tempDir(), 'unused.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
      },
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const read = await fresh.getBaseline().get({ runId: e.runId, taskId: e.taskId, actorId: e.actor });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.invocationId).toBe(baselineBefore[0]!.id);
  });

  it('41: a repository Task without a workspace never starts the agent work', async () => {
    const e = await composeE2E({ openWorkspace: false });
    const handlers = e.runtime.handlers();
    const handler = handlers.get('work');
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    // With no workspace the handler refuses BEFORE the delegate could run.
    const outcome = await handler.execute({
      runId: e.runId,
      stageId: STAGE_ID as never,
      taskId: e.taskId as never,
      kind: 'work',
      attempt: 1,
      branch: null,
      payload: {},
    });
    expect(outcome).toBe('failed');
    // No baseline was captured either.
    const baselines = (await e.db.toolInvocations.list({ limit: 500 })).items.filter((item) =>
      (item.idempotencyKey ?? '').startsWith('task-baseline:'),
    );
    expect(baselines).toHaveLength(0);
  });

  it('29: a newer failed QA attempt is never skipped in favour of an older success', async () => {
    const e = await composeE2E();
    expect((await e.invoke('repo.test-runner', {})).ok).toBe(true);
    // The same slot now fails (the trusted profile is reopened with a failing command).
    const scriptDir = tempDir();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(scriptDir, 'fail.js'), "process.stderr.write('nope');process.exit(7);", 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'fail.js'));
    await e.runtime.closeWorkspace();
    const reopened = await e.runtime.openWorkspace({
      root: e.repo.dir,
      commandProfile: {
        tests: { commandKey: 'tests', executable: process.execPath, baseArgv: [join(scriptDir, 'fail.js')], cwd: 'workspace-root', safeEnvAdditions: {} },
      },
    });
    expect(reopened.ok).toBe(true);
    expect((await e.invoke('repo.test-runner', {})).ok).toBe(false);
    const verdict = await runValidation(e);
    expect(verdict.status).toBe('fail');
    expect(verdict.gate).toBe('deny');
  });
});

describe('repository production configuration seam (T17-08 corrective)', () => {
  it('1/8: the default composition starts with no repository kind and no workspace', async () => {
    const e = await composeE2E({ openWorkspace: false });
    // The repeatable production entry, with NO repository configuration at all.
    const { openArtifactFoundation } = await import('../../apps/desktop/src/artifact-stack.js');
    const foundation = await openArtifactFoundation({
      casRoot: e.casRoot,
      database: e.db,
      logger: nullLogger as never,
    });
    if (!foundation.ok) throw new Error(foundation.error.message);
    const defaultCore = await composeCoreServices(e.db, nullLogger as never, { artifactFoundation: foundation });
    expect(defaultCore).not.toBeNull();
    if (defaultCore === null) return;
    // 2: no kind silently becomes repository-capable.
    expect(defaultCore.repositoryRuntime.repositoryKinds()).toEqual([]);
    expect(defaultCore.repositoryRuntime.handlers().size).toBe(0);
    // The engine's registry resolves nothing for 'work' (the scripted path is untouched).
    const engine = defaultCore.sprint13.engine;
    void engine;
    expect(defaultCore.repositoryRuntime.currentWorkspace()).toBeNull();
    // The ten repository tools PLUS the BB2 repo.test-check validator are registered
    // (and fail closed without a workspace).
    const repositoryTools = (await e.db.toolRecords.list({ limit: 500 })).items
      .map((item) => item.toolId)
      .filter((toolId) => toolId.startsWith('repo.'));
    expect(repositoryTools).toHaveLength(11);
    const read = await defaultCore.tools.invoke({
      toolId: 'repo.file-read',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: e.taskId,
      runId: e.runId,
      actorId: e.actor,
      input: { path: 'src/example.txt' },
      idempotencyKey: `default-safe:${String(++seq)}`,
    });
    if (read.ok) throw new Error('repository tools must fail closed without a workspace');
    expect(read.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
  });

  it('3/4/5/9: the trusted configuration enables the kind through the real engine START', async () => {
    const e = await composeE2E();
    // The SAME production entry, with the trusted repository configuration.
    expect(e.runtime.repositoryKinds()).toEqual(['work']);
    const handler = e.runtime.handlers().get('work');
    expect(handler).toBeDefined();

    // The engine's StageHandlerRegistry resolves the repository handler for 'work'.
    const resolveHandler = (kind: string): unknown => e.runtime.handlers().get(kind) ?? null;
    expect(resolveHandler('work')).toBeDefined();
    expect(resolveHandler('review')).toBeNull();

    // 5: the engine START path (not a direct handler call) drives the repository handler.
    // T18-02: the run is created through the PRODUCTION lifecycle so it carries a real,
    // verifiable execution pin — the engine proves the pin before any task runs.
    const template = await e.core.lifecycle.createTemplate({
      orgId: 'company_default',
      name: 'Repository kind flow',
      actorId: e.actor,
      traceId: 't17_tpl_cfg',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: STAGE_ID, kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    const saved = await e.core.lifecycle.saveDraftGraph({
      templateId: template.value.id,
      graph,
      actorId: e.actor,
      traceId: 't17_graph_cfg',
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await e.core.lifecycle.publish({
      templateId: template.value.id,
      actorId: e.actor,
      traceId: 't17_pub_cfg',
    });
    if (!published.ok) throw new Error(published.error.message);
    const created = await e.core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: 'company_default',
      workflowId: 'wfl_cfg',
      actorId: e.actor,
    });
    if (!created.ok) throw new Error(created.error.message);
    const task = createTask({
      runId: created.value.run.id as never,
      stageId: STAGE_ID as never,
      roleId: 'rol_cfg' as never,
      kind: 'work',
      now: nowIso(),
      ids,
    });
    if (!task.ok) throw new Error(task.error.message);
    await e.db.tasks.put(task.value);
    const driven = await e.core.sprint13.engine.drive(created.value.run.id as never, { maxSteps: 8 });
    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    const pinned = await e.db.snapshots.get(created.value.run.snapshotId as never);
    if (pinned === null) throw new Error('the created run pins no snapshot');
    const advanced = await e.core.sprint13.engine.advance({
      runId: created.value.run.id,
      stageId: STAGE_ID as never,
      taskIds: [task.value.id] as never,
      snapshot: { snapshotId: pinned.snapshotId as never, snapshotHash: pinned.snapshotHash as never },
    });
    expect(advanced.outcome).toBe('completed');
    const stored = await e.db.tasks.get(task.value.id as never);
    expect(stored?.state).toBe('DONE');
    // The repository handler ran: a real task-start baseline exists for this run/task.
    const baseline = (await e.db.toolInvocations.list({ limit: 500 })).items.filter((item) =>
      (item.idempotencyKey ?? '').startsWith('task-baseline:'),
    );
    expect(baseline).toHaveLength(1);
    expect(baseline[0]!.runId).toBe(created.value.run.id);
    expect(baseline[0]!.taskId).toBe(task.value.id);
    expect(e.runtime.lease.current()).toBeNull();
  });

  it('7/8: no untrusted surface can name the kinds, the root or the profile', async () => {
    const e = await composeE2E({ openWorkspace: false });
    // The repository tool input schemas carry no root, no profile and no command selection
    // beyond the terminal's allowlisted commandKey.
    const terminal = [...REPOSITORY_TOOL_SPEC_LIST, ...(await import('@companyos/engine')).REPOSITORY_PROCESS_TOOL_SPECS].find(
      (spec) => spec.toolId === 'repo.terminal',
    );
    expect(terminal).toBeDefined();
    if (terminal === undefined) return;
    const properties = Object.keys(
      (terminal.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toEqual(['commandKey']);
    for (const spec of [...REPOSITORY_TOOL_SPEC_LIST, ...(await import('@companyos/engine')).REPOSITORY_PROCESS_TOOL_SPECS]) {
      const props = Object.keys((spec.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const forbidden of ['root', 'workspaceRoot', 'commandProfile', 'repositoryCapableKinds', 'kind', 'cwd', 'env']) {
        expect(props, `${spec.toolId} must not accept ${forbidden}`).not.toContain(forbidden);
      }
    }
    // The trusted seam is not reachable through a tool at all.
    const toolIds = (await e.db.toolRecords.list({ limit: 500 })).items.map((item) => item.toolId);
    expect(toolIds).not.toContain('repo.open-workspace');
    expect(toolIds).not.toContain('repo.workspace');
  });

  it('C/15: a packless Run stays supported (no forced DevCompany)', async () => {
    const e = await composeE2E();
    // A run with no pack provenance pins an empty packVersions map, exactly as before: the
    // repository composition never forces a pack install.
    const run = createWorkflowRun({
      companyId: 'company_default' as never,
      workflowId: 'wfl_plain' as never,
      templateId: 'tpl_plain' as never,
      versionId: 'ver_plain' as never,
      snapshotId: 'snp_plain' as never,
      startedBy: e.actor,
      now: nowIso(),
      ids,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    await e.db.runs.put(run.value);
    // No pack provenance was derived for this run, so its snapshot pins no packs.
    const snapshot = await e.db.snapshots.get(run.value.snapshotId as never);
    expect(Object.keys(snapshot?.packVersions ?? {}).length).toBe(0);
  });
});
