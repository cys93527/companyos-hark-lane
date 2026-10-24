import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoalExecutionBudget } from '@companyos/engine';
import { createFilesystemArtifactContentStore } from '@companyos/persistence';
import { createCoreDomainEvent, executionAttemptIdOf, ok } from '@companyos/core';
import { createHandoffService, resolveExecutorConfig, type HandoffAuditPayload, type ExecutorProviderRegistry } from '@companyos/engine';
import { COMPANY, composeF5, createdDirs, openDatabases } from './helpers/f5-fixture.js';
import { createFileDeliveryPort, createVerifiedFileCarrier, deliveryPath, fileDeliveriesOf, readDeliveryFile, type FileDeliveryContext } from '../../apps/desktop/src/verified-file-delivery.js';
import { createProviderDispatchExecution } from '../../apps/desktop/src/executor/provider-dispatch.js';
import { recordRuntimeHandoff } from '../../apps/desktop/src/executor/runtime-collaboration.js';
import { saveOfflinePackageTraces } from '../support/offline-fixtures.js';
import type * as RepoTestProcess from '../../apps/desktop/src/repo-test-process.js';

const observed = vi.hoisted(() => ({ runs: [] as { exitCode: number; timedOut: boolean; outputTail: string }[] }));
// This root alone registers the reviewed snapshot before the ORIGINAL process port.
// No fake verdict/output: actual Node assertions, capture and close/exit still run.
// The guard rejects unknown scripts/modules/aliases and expands only finite fixtures;
// this is not evidence for native CMD/npm or real DSH transport.
vi.mock('../../apps/desktop/src/repo-test-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RepoTestProcess>();
  const { registerOfflinePackageSnapshot } = await import('../support/offline-fixtures.js');
  return { ...actual, runRepoTestContract: async (input: Parameters<typeof actual.runRepoTestContract>[0]) => {
    registerOfflinePackageSnapshot(input.cwd);
    const result = await actual.runRepoTestContract({ ...input, timeoutMs: Math.min(input.timeoutMs, 5000) });
    observed.runs.push(result);
    return result;
  } };
});

afterEach(() => { saveOfflinePackageTraces(); observed.runs.length = 0; while (openDatabases.length) openDatabases.pop()?.close(); while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true }); });
const bytes = Buffer.from('Offline file delivery fixture.\n', 'utf8');
const hash = createHash('sha256').update(bytes).digest('hex');
const requirements = [{ criterionId: 'c1', relativePath: 'result.txt', maxBytes: 1024, expectedSha256: hash, expectedSizeBytes: bytes.length }];
const fixture = async () => {
  const f = await composeF5({ executionSafety: { policyId: 'OFFLINE_FILE_FIXTURE', maxCalls: 20, maxTokens: 1000000, maxCostMicros: 1000000, durationMs: 120000, boundOf: ({ modelKey }) => ({ modelKey, inputTokens: 20000, outputTokens: 16000, costMicros: 1000, evidenceRef: 'OFFLINE_ONLY', validUntilMs: Date.now() + 120000 }), costOf: () => 1 } });
  const created = await f.core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, commandId: 'offline-file-goal', objective: 'offline file carrier fixture', accessPolicy: 'ASK_PERMISSION', structured: { fileDeliveries: requirements } } });
  if (!created.ok) throw created.error;
  const goalRunId = (created.value as { runId: string }).runId;
  await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
  const child = f.core.database.db.prepare('SELECT id FROM runs WHERE execution_goal_run_id = ? AND id != ?').get(goalRunId, goalRunId) as { id: string } | undefined;
  if (child === undefined) throw new Error('offline canonical plan did not compile');
  const tasks = await f.core.database.tasks.listByRun(child.id);
  const task = tasks.find((item) => item.kind === 'companyos:software-work');
  if (task === undefined) throw new Error('canonical work task missing');
  const context: FileDeliveryContext = { goalRunId, runId: child.id, taskId: task.id, workspace: f.workspace, requirements, validatorIds: ['repo.test-check', 'evidence.grounding-check'] };
  // A real deterministic local test contract, required by the pinned software validator.
  mkdirSync(join(f.workspace, 'src')); mkdirSync(join(f.workspace, 'tests'));
  writeFileSync(join(f.workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }));
  writeFileSync(join(f.workspace, 'src/math.ts'), 'export const multiply = (a: number, b: number) => a * b;\n');
  writeFileSync(join(f.workspace, 'tests/math.test.ts'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from '../src/math.ts'; test('multiply', () => assert.equal(multiply(4, 3), 12));\n");
  const actorId = (await f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  const budget = createGoalExecutionBudget(f.core.database.executionBudget, Date.now);
  const carrier = createVerifiedFileCarrier({ artifacts: f.core.sprint13.artifactService, validation: f.core.sprint13.validationService, actorId, checkActive: budget.check });
  const declaration = () => JSON.stringify({ schema: 'companyos/business-files/1', goalRunId, runId: child.id, taskId: task.id, files: [{ relativePath: 'result.txt', sizeBytes: bytes.length, sha256: hash }] });
  const deliver = (finalText = declaration(), attemptId = 'offline-attempt') => carrier({ context, attemptId, finalText });
  return { f, context, carrier, deliver, declaration, budget };
};

// A deterministic executor with no network/kernel; actual file/CAS/Validator and
// the existing Handoff service/store persist all evidence, never fake output refs.
const dispatchDelivery = async (t: Awaited<ReturnType<typeof fixture>>) => {
  const task = await t.f.core.database.tasks.get(t.context.taskId);
  const run = await t.f.core.database.runs.get(t.context.runId);
  if (task === null || run === null) throw new Error('canonical ownership missing');
  const actorId = (await t.f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  const emit = (type: string) => async (payload: HandoffAuditPayload) => { await t.f.core.database.events.append([createCoreDomainEvent(type as never, { type: 'Handoff', id: payload.handoffId }, { ...payload }, { traceId: payload.traceId, actorId, now: t.f.core.clock.nowIso(), ids: t.f.core.ids })]); };
  const handoffs = createHandoffService({ store: t.f.core.database.handoffStore!, clock: t.f.core.clock, authorize: ({ actorId, authority }) => t.f.core.authz.decide({ actorId, authority }), actorRoleIds: async (actor) => (await t.f.core.authz.assignmentsOf(actor)).map((assignment) => assignment.roleId), durableReferenceResolver: t.f.core.sprint13.durableReferenceResolver, audit: { created: emit('handoff.created'), ready: emit('handoff.ready'), accepted: emit('handoff.accepted'), rejected: emit('handoff.rejected'), cancelled: emit('handoff.cancelled'), superseded: emit('handoff.superseded') } });
  const attemptId = executionAttemptIdOf({ companyId: COMPANY, runId: t.context.runId, taskId: t.context.taskId, attemptNumber: 2 });
  const config = resolveExecutorConfig({ providerKey: 'offline-file', schema: { profile: { name: 'profile', kind: 'string', required: false, defaultValue: 'offline-file' } }, envNames: {} }); if (!config.ok) throw config.error;
  const dispatch = createProviderDispatchExecution({
    registry: { resolve: () => ({ descriptor: { providerKey: 'offline-file', capabilities: ['structured-output'] }, start: async () => ({ kind: 'succeeded', exitCode: 0, stdoutText: t.declaration(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }) }) } as unknown as ExecutorProviderRegistry,
    dispatches: t.f.core.database.providerDispatches, clock: { nowIso: () => new Date().toISOString() },
    workspaceOf: () => t.f.workspace, requiredCapabilitiesOf: () => [], configOf: () => config.value,
    authorizationOf: async () => ({ present: true, source: 'composition-policy', reference: 'offline-file-test' }),
    workContextOf: async () => ok({ objective: 'offline verified-file handoff', acceptanceCriteria: [{ criterionId: 'c1', requirement: 'deliver result.txt' }], goalStructured: { fileDeliveries: requirements } }),
    verifyFileDeliveryOf: (input) => t.carrier({ ...input, context: t.context }),
    recordHandoffOf: async (input) => {
      await t.budget.check(input.runId);
      const handoffId = `ho_${input.attemptId}`;
      const result = await recordRuntimeHandoff({
        createDraft: async (payload) => handoffs.createDraft(payload),
        ready: async (payload) => t.f.core.database.unitOfWork.transaction(async () => { await t.budget.check(input.runId); const result = await handoffs.ready(payload); if (!result.ok) throw result.error; return result.value; }),
      }, {
        mapping: { handoffId, companyId: COMPANY, workflowId: String(run.templateId), workflowVersionId: String(run.versionId), workflowRunId: input.runId, stageId: String(task.stageId), taskId: input.taskId, fromAgentId: actorId, fromRoleId: String(task.roleId), toRoleId: String(task.roleId), objective: input.objective, recommendedNextAction: 'review the verified file', traceId: 'offline-file-handoff', createdAt: new Date().toISOString(), actorId },
        handoff: { handoffId, producerRoleInstanceId: String(task.roleId), consumerRoleInstanceId: String(task.roleId), sourceTaskId: input.taskId, targetTaskId: input.taskId, artifactRefs: input.artifactRefs, evidenceRefs: input.validationRefs ?? [], decisionRefs: [], acceptanceCriteria: [], knownRisks: [], remainingQuestions: [], handoffReason: input.objective },
      });
      return result.ok ? ok({ handoffId, recorded: true }) : result;
    },
  });
  return dispatch.execute({ companyId: COMPANY, runId: t.context.runId, taskId: t.context.taskId, roleId: String(task.roleId), taskKind: task.kind, attemptNumber: 2, attemptId }, 'offline-file');
};

describe('ADR-C actual file carrier (offline canonical CAS / Validation only)', () => {
  it('the real dispatch carrier transfers only verified file and PASS refs to canonical READY Handoff', async () => {
    const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes);
    const result = await dispatchDelivery(t);
    expect(observed.runs).toHaveLength(1);
    expect(observed.runs[0]).toMatchObject({ exitCode: 0, timedOut: false });
    expect(observed.runs[0]?.outputTail).toMatch(/pass 1/);
    expect(result.output, JSON.stringify(result.failure)).not.toBe('failed');
    const rows = t.f.core.database.db.prepare('SELECT handoff_id,status FROM handoffs').all() as { handoff_id: string; status: string }[];
    expect(rows).toHaveLength(1); expect(rows[0]?.status).toBe('READY');
    const packet = await t.f.core.database.handoffStore!.get(rows[0]!.handoff_id, 1);
    expect(packet?.artifactRefs).toHaveLength(1); expect(packet?.validationRefs).toHaveLength(3);
    for (const ref of packet!.artifactRefs) expect((await t.f.core.database.artifactStore!.get(ref.refId as never))?.kind).toBe('companyos:business-file:result.txt');
    for (const ref of packet!.validationRefs) expect((await t.f.core.database.validationStore!.get(ref.refId as never))?.status).toBe('pass');
  });
  it('missing actual file cannot create a READY Handoff despite exit zero', async () => {
    const t = await fixture(); const result = await dispatchDelivery(t); expect(result.output).toBe('failed');
    expect(t.f.core.database.db.prepare('SELECT handoff_id FROM handoffs').all()).toHaveLength(0);
  });
  it('a failing pinned software Validator blocks file Handoff even with matching file hash', async () => {
    const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes);
    writeFileSync(join(t.f.workspace, 'src/math.ts'), 'export const multiply = (a: number, b: number) => a - b;\n');
    const result = await dispatchDelivery(t); expect(result.output).toBe('failed'); expect(result.failure?.reason).toBe('FILE_VALIDATION_NOT_PASS');
    expect(observed.runs).toHaveLength(1);
    expect(observed.runs[0]).toMatchObject({ exitCode: 1, timedOut: false });
    expect(observed.runs[0]?.outputTail).toMatch(/fail 1/);
    expect(t.f.core.database.db.prepare('SELECT handoff_id FROM handoffs').all()).toHaveLength(0);
  });
  it('rejects textual success when no actual file exists', async () => { const t = await fixture(); expect((await t.deliver()).ok).toBe(false); expect(t.f.core.database.db.prepare("SELECT artifact_id FROM artifacts WHERE kind LIKE 'companyos:business-file:%'").all()).toHaveLength(0); });
  it('rejects empty actual files even after provider exit zero', async () => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), ''); expect((await t.deliver()).ok).toBe(false); });
  it('rejects a false hash or size declaration', async () => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes); const d = JSON.parse(t.declaration()); d.files[0].sha256 = '0'.repeat(64); expect((await t.deliver(JSON.stringify(d))).ok).toBe(false); d.files[0].sha256 = hash; d.files[0].sizeBytes++; expect((await t.deliver(JSON.stringify(d))).ok).toBe(false); });
  it('rejects actual content which contradicts the human Goal contract', async () => { const t = await fixture(); const other = Buffer.from('Different content'); writeFileSync(join(t.f.workspace, 'result.txt'), other); const d = JSON.parse(t.declaration()); d.files[0].sha256 = createHash('sha256').update(other).digest('hex'); d.files[0].sizeBytes = other.length; expect((await t.deliver(JSON.stringify(d))).ok).toBe(false); });
  it.each(['goalRunId', 'runId', 'taskId'])('rejects wrong %s ownership before CAS writes', async (key) => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes); const d = JSON.parse(t.declaration()); d[key] = 'other'; expect((await t.deliver(JSON.stringify(d))).ok).toBe(false); expect(t.f.core.database.db.prepare("SELECT artifact_id FROM artifacts WHERE kind LIKE 'companyos:business-file:%'").all()).toHaveLength(0); });
  it('persists exact bytes and targeted blocking PASS through existing authorities', async () => {
    const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes); const result = await t.deliver();
    if (!result.ok) throw result.error; expect(result.ok).toBe(true);
    expect(result.value.artifactRefs).toHaveLength(1); expect(result.value.validationRefs).toHaveLength(3);
    const artifact = await t.f.core.database.artifactStore!.get(result.value.artifactRefs[0]! as never);
    expect(artifact).toMatchObject({ runId: t.context.runId, taskId: t.context.taskId, contentHash: hash, sizeBytes: bytes.length });
    expect(Buffer.from((await createFilesystemArtifactContentStore({ casRoot: t.f.casRoot }).get(artifact!.contentRef))!)).toEqual(bytes);
    const validation = await t.f.core.database.validationStore!.get(result.value.validationRefs[0]! as never);
    expect(validation).toMatchObject({ status: 'pass', blocking: true, taskId: t.context.taskId, targetRef: `artifact:${artifact!.id}` });
  });
  it('replay is idempotent even after ledger trimming', async () => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes); const first = await t.deliver(); expect(first.ok).toBe(true); t.f.core.database.db.prepare("DELETE FROM command_ledger WHERE command_id LIKE '%offline-attempt%'").run(); expect(await t.deliver()).toEqual(first); });
  it('a failed or disabled canonical Validator cannot yield delivery success', async () => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes); const actor = (await t.f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId; await t.f.core.tools.setEnabled('file.delivery-check', false, actor); expect((await t.deliver()).ok).toBe(false); expect(t.f.core.database.db.prepare('SELECT handoff_id FROM handoffs').all()).toHaveLength(0); });
  it('cancelled Goal cannot materialize or validate a late file', async () => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'result.txt'), bytes); await t.budget.requestCancel(t.context.runId, 'offline-cancel'); expect((await t.deliver()).ok).toBe(false); expect(t.f.core.database.db.prepare("SELECT artifact_id FROM artifacts WHERE kind LIKE 'companyos:business-file:%'").all()).toHaveLength(0); });
  it('independent Validator rejects canonical artifacts from another Task', async () => { const t = await fixture(); const created = await t.f.core.sprint13.artifactService.create({ commandId: 'wrong-task', runId: t.context.runId as never, kind: 'companyos:business-file:result.txt', content: bytes, producedBy: 'user_owner', traceId: 'offline' }); if (!created.ok) throw created.error; const port = createFileDeliveryPort({ contextOf: async () => t.context, artifactOf: async () => created.value, contentOf: async () => bytes, nowIso: () => new Date().toISOString() }); const result = await port.invoke({ toolId: 'file.delivery-check', runId: t.context.runId, taskId: t.context.taskId, input: { artifactId: created.value.id, targetRef: `artifact:${created.value.id}` }, executionId: 'offline', actorId: 'offline', agentId: 'offline', traceId: 'offline', timeoutMs: 1000, idempotencyKey: null }); expect(result.ok && (result.value.output as { verdict: string }).verdict).toBe('fail'); });
  it('rejects path traversal, device names, alternate streams, and duplicate aliases', () => { for (const p of ['../x', 'x/../y', 'C:/x', 'x:y', 'CON.txt', 'x\\y', '/x', 'x.']) expect(() => deliveryPath(p)).toThrow(); expect(() => fileDeliveriesOf({ fileDeliveries: [{ ...requirements[0], relativePath: 'A.txt' }, { ...requirements[0], criterionId: 'c2', relativePath: 'a.txt' }] })).toThrow(); });
  it('rejects hardlinks and junction paths instead of importing outside aliases', async () => { const t = await fixture(); writeFileSync(join(t.f.workspace, 'source.txt'), bytes); linkSync(join(t.f.workspace, 'source.txt'), join(t.f.workspace, 'result.txt')); expect(() => readDeliveryFile(t.f.workspace, 'result.txt', 1024)).toThrow(); const outside = join(t.f.dataDir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'file.txt'), bytes); symlinkSync(outside, join(t.f.workspace, 'alias'), 'junction'); expect(() => readDeliveryFile(t.f.workspace, 'alias/file.txt', 1024)).toThrow(); });
  it('rejects a planner which drops a human file-delivery criterion', async () => { const f = await composeF5(); const created = await f.core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, commandId: 'omitted-contract', objective: 'offline', structured: { fileDeliveries: [{ ...requirements[0], criterionId: 'not-in-offline-plan' }] } } }); if (!created.ok) throw created.error; const result = await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: (created.value as { runId: string }).runId } }); expect(result).toMatchObject({ ok: false, error: { details: { reason: 'FILE_DELIVERY_PLAN_COVERAGE_MISSING' } } }); });
});
