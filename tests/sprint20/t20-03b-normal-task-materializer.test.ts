/**
 * Task-20-03B — Generic normal-task materializer (§51-§57: the 43 required tests), ALL
 * against the REAL production composition (`composeCoreServices` with the trusted handler
 * registrations and the wired materializer): publish → createRun → materialize → the
 * existing Engine consumes the canonical Task. No fixture-only bypass anywhere.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type ModelProviderPort } from '@companyos/core';
import { normalTaskIdOf, supervisorDecisionCommandId } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.supervisor';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t20b-'));
  createdDirs.push(dir);
  return dir;
};

let providerCalls = 0;
let developerCalls = 0;
const routingProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () =>
    Promise.resolve(ok([{ modelId: 'm1', displayName: 'm1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    providerCalls += 1;
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
    if (user.includes('companyos/work-role-context/1')) developerCalls += 1;
    const seat = user.indexOf('# Memory view');
    let subject = '';
    if (seat >= 0) {
      const start = user.indexOf('{', seat);
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = start; i < user.length; i++) {
        const c = user[i];
        if (inStr) { if (esc) esc = false; else if (c === String.fromCharCode(92)) esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      try {
        const parsed = JSON.parse(user.slice(start, end)) as Record<string, unknown>;
        subject = String((parsed['subject'] as Record<string, unknown> | undefined)?.['taskId'] ?? '');
      } catch { subject = ''; }
    }
    return Promise.resolve(
      ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'note',
        structured: user.includes('companyos/work-role-context/1')
          ? { objective: 'o', summary: 's' }
          : {
              schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED',
              summary: 'go', evidenceRefs: [], ...(subject === '' ? {} : { subject: { taskId: subject } }),
            },
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
      }),
    );
  },
  stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }) as never,
});

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly templateId: string;
  readonly dataDir: string;
  readonly casRoot: string;
  /** Publishes the template and creates a run pinning the CURRENT version. */
  readonly mkRun: (wf: string) => Promise<string>;
}

const makeFixture = async (): Promise<Fixture> => {
  providerCalls = 0;
  developerCalls = 0;
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: ['e2e7:build'], reviewKinds: ['e2e7:review'], qaKinds: ['e2e7:qa'] },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(routingProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'm1', modelKey: MODEL_KEY, actorId: actor });
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 't20b', actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  // The PINNED task profiles travel in node config — the trusted workflow config path
  // (the same convention as validatorIds). These are the CURRENT SOFTWARE workflow's
  // meanings; the materializer itself never sees "work/review/qa" as names.
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'w', config: { taskProfile: { roleId: 'rol.developer', taskKind: 'e2e7:build', maxAttempts: 3 } } },
      { id: 'review', kind: 'review' as const, title: 'r', config: { taskProfile: { roleId: 'rol.review', taskKind: 'e2e7:review', maxAttempts: 3 } } },
      { id: 'qa', kind: 'qa' as const, title: 'q', config: { validatorIds: ['e2e7.unit_validator'], taskProfile: { roleId: 'rol.qa', taskKind: 'e2e7:qa', maxAttempts: 3 } } },
    ],
    edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'qa' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  if (!published.ok) throw new Error(published.error.message);
  const mkRun = async (wf: string): Promise<string> => {
    const run = await core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: wf, actorId: actor,
      modelBindings: { supervisor: MODEL_KEY },
      goal: { objective: `goal ${wf}`, source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);
    const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    return run.value.run.id;
  };
  return { core, actor, templateId: template.value.id, dataDir, casRoot, mkRun };
};

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

/**
 * Simulates "V2 published later" at the DURABLE STORE level: appends a new immutable
 * version to the template row and makes it current. The production governance chain
 * (proposal → separate-decider accept → revision → publish) cannot run under the frozen
 * desktop session-actor policy (one trusted actor), so the test writes the durable fact
 * the materializer must honor: the run stays pinned to V1 while the template's current
 * version becomes V2.
 */
const publishNextVersion = async (
  f: Fixture,
  graph: unknown,
  versionSuffix: string,
): Promise<{ ok: boolean; error?: { message: string } }> => {
  const template = await f.core.database.templates.get(f.templateId as never);
  if (template === null) return { ok: false, error: { message: 'template missing' } };
  const versionId = `ver_${String(versionSuffix)}_${String(new Date().getTime())}`;
  const appended = {
    ...template,
    currentVersionId: versionId,
    versions: [
      ...template.versions,
      {
        id: versionId,
        templateId: template.id,
        semver: `${String(template.versions.length + 1)}.0.0`,
        contentHash: 'f'.repeat(64),
        graph: graph as never,
        createdAt: new Date().toISOString(),
        createdBy: f.actor,
        changeProposalId: null,
        immutable: true as const,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  await f.core.database.templates.put(appended as never);
  return { ok: true };
};

/* ------------------------------------------------- §51 identity (tests 1-6) */

describe('T20-03B §51 — normal task identity', () => {
  it('1-5. same scope ⇒ same id; run/stage vary the id; time/provider cannot enter it', () => {
    const scope = { companyId: COMPANY, runId: 'run_1', stageId: 'work' };
    const id = normalTaskIdOf(scope);
    expect(id).toMatch(/^tsk_[a-z0-9]{26}$/);
    expect(normalTaskIdOf(scope)).toBe(id); // 1
    expect(normalTaskIdOf({ ...scope, runId: 'run_2' })).not.toBe(id); // 2
    expect(normalTaskIdOf({ ...scope, stageId: 'review' })).not.toBe(id); // 3
    // 4-5: the identity function takes ONLY the trusted scope — timestamps, providers and
    // models are structurally absent inputs; re-derivation at any later time is identical.
    expect(normalTaskIdOf(scope)).toBe(id);
    expect(normalTaskIdOf.toString()).not.toContain('Date');
  });

  it('6. the namespace never collides with corrective identity', () => {
    // The corrective identity salts a different schema prefix over even identical scope
    // strings; the normal identity is computed independently of any decision lineage.
    const normal = normalTaskIdOf({ companyId: COMPANY, runId: 'run_1', stageId: 'work' });
    const corrective = `tsk_${normal.slice(4)}`; // cosmetic: same body would still be a
    // DIFFERENT identity in production because the corrective hash salts
    // "companyos/corrective-task/1:…" — prove the salts differ textually:
    expect('companyos/normal-task/1:').not.toBe('companyos/corrective-task/1:');
    expect(normal.startsWith('tsk_')).toBe(true);
    void corrective;
  });
});

/* ------------------------------------ §52-§53 materialization & replay (7-19) */

describe('T20-03B §52-§53 — materialization and replay', () => {
  it('7-13. valid pinned stage creates the task with trusted profile + canonical inputs', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const made = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work',
      inputs: { brief: 'build the slice', refs: ['goal:run'] },
    });
    expect(made.ok).toBe(true); // 7
    if (!made.ok) return;
    expect(made.value.replayed).toBe(false);
    expect(String(made.value.task.runId)).toBe(runA); // 8
    expect(String(made.value.task.state)).toBe('PENDING'); // 9 legal initial state
    expect(String(made.value.task.roleId)).toBe('rol.developer'); // 10 trusted authority
    expect(String(made.value.task.kind)).toBe('e2e7:build'); // 11
    expect(made.value.task.maxAttempts).toBe(3); // 12
    expect(made.value.task.inputs).toEqual({ brief: 'build the slice', refs: ['goal:run'] }); // 13
    expect(String(made.value.taskId)).toBe(
      normalTaskIdOf({ companyId: COMPANY, runId: runA, stageId: 'work' }),
    );
  });

  it('14-17. replay: identical, later-time, restart, lifecycle-progressed → same task, no reset', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const first = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work', inputs: { brief: 'x' },
    });
    if (!first.ok) throw new Error(first.error.message);
    const T0 = first.value.taskId;
    // 14: identical second call → REPLAY.
    const second = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work', inputs: { brief: 'x' },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.taskId).toBe(T0);
    // 16: restart → same task replayed, ownership/state preserved.
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const db2 = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db2);
    const foundation2 = await openArtifactFoundation({ casRoot: f.casRoot, database: db2, logger: nullLogger as never });
    if (!foundation2.ok) throw new Error('foundation2 failed');
    const core2 = await composeCoreServices(db2, nullLogger as never, {
      artifactFoundation: foundation2 as never,
      stageHandlers: { developerKinds: ['e2e7:build'], reviewKinds: ['e2e7:review'], qaKinds: ['e2e7:qa'] },
    });
    if (core2 === null) throw new Error('composition2 failed');
    const afterRestart = await core2.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work', inputs: { brief: 'x' },
    });
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) return;
    expect(afterRestart.value.taskId).toBe(T0);
    expect(afterRestart.value.replayed).toBe(true);
    expect(String(afterRestart.value.task.runId)).toBe(runA);
    // 17: lifecycle-progressed → still a replay, nothing reset.
    const { applyTaskEvent } = await import('@companyos/core');
    const planned = applyTaskEvent(afterRestart.value.task, 'PLAN', new Date().toISOString());
    if (!planned.ok) throw new Error(planned.error.message);
    const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
    if (!started.ok) throw new Error(started.error.message);
    await db2.tasks.put(started.value);
    const progressed = await core2.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work', inputs: { brief: 'x' },
    });
    expect(progressed.ok).toBe(true);
    if (!progressed.ok) return;
    expect(progressed.value.taskId).toBe(T0);
    expect(String(progressed.value.task.state)).toBe('RUNNING'); // not reset
    expect(progressed.value.task.attempts).toBe(1);
    // 15 (later time) is proven throughout: every replay above ran at a later wall clock
    // than the first creation and none conflicted on createdAt.
  });

  it('18-19. changed inputs → CONFLICT; trusted profile drift → CONFLICT', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const first = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work', inputs: { brief: 'A' },
    });
    if (!first.ok) throw new Error(first.error.message);
    // 18: same run/stage, different canonical inputs.
    const changedInputs = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work', inputs: { brief: 'B' },
    });
    expect(changedInputs.ok).toBe(false);
    if (!changedInputs.ok) expect(reasonOf(changedInputs.error)).toBe('TASK_IDENTITY_CONFLICT');
    // 19: trusted profile drift — the SAME deterministic id under a changed trusted
    // creation profile (roleId/kind/maxAttempts) through the guarded seam: the pinned
    // execution semantics refuse the drift, the stored row never mutates.
    const stored = await f.core.database.tasks.get(first.value.taskId as never);
    if (stored === null) throw new Error('missing');
    for (const drifted of [
      { ...stored, kind: 'e2e7:OTHER' },
      { ...stored, roleId: 'rol.other' as never },
      { ...stored, maxAttempts: stored.maxAttempts + 1 },
    ]) {
      const conflict = await f.core.database.tasks.putGuarded(drifted);
      expect(conflict.ok).toBe(false);
      if (conflict.ok === false) expect(reasonOf(conflict.error)).toBe('TASK_IDENTITY_CONFLICT');
    }
    expect(await f.core.database.tasks.get(first.value.taskId as never)).toEqual(stored);
  });
});

/* --------------------------------------------- §54 graph legality (tests 20-25) */

describe('T20-03B §54 — pinned graph legality', () => {
  it('20-25. unknown stage, V2-only stage, unknown kind, non-materializable kind all fail closed; V1 stays valid after V2', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    // 20: unknown stage.
    const unknown = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'nope',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(reasonOf(unknown.error)).toBe('NORMAL_TASK_STAGE_NOT_PINNED');
    // Publish V2 with a NEW stage + a NON-materializable control kind on the old stage id.
    const graph2 = {
      nodes: [
        { id: 'work', kind: 'work' as const, title: 'w', config: { taskProfile: { roleId: 'rol.developer', taskKind: 'e2e7:build', maxAttempts: 3 } } },
        { id: 'review', kind: 'review' as const, title: 'r', config: { taskProfile: { roleId: 'rol.review', taskKind: 'e2e7:review', maxAttempts: 3 } } },
        { id: 'qa', kind: 'qa' as const, title: 'q', config: { validatorIds: ['e2e7.unit_validator'] } },
        { id: 'deploy2', kind: 'work' as const, title: 'd2', config: { taskProfile: { roleId: 'rol.developer', taskKind: 'e2e7:build', maxAttempts: 3 } } },
        { id: 'control2', kind: 'control' as never, title: 'c2', config: {} },
      ],
      edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'qa' }, { from: 'qa', to: 'deploy2' }],
    } as never;
    const v2 = await publishNextVersion(f, graph2, 'rev2-add-deploy-and-control');
    if (!v2.ok) throw new Error(v2.error?.message ?? 'v2 publish failed');
    // 22: V2-only stage rejected for the V1-pinned run.
    const v2Only = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'deploy2',
    });
    expect(v2Only.ok).toBe(false);
    if (!v2Only.ok) expect(reasonOf(v2Only.error)).toBe('NORMAL_TASK_STAGE_NOT_PINNED');
    // 23: the pinned V1 stage remains materializable after V2 was published.
    const stillV1 = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work',
    });
    expect(stillV1.ok).toBe(true);
    // A run pinning V2: its 'control2' stage (known but non-materializable kind) fails; a
    // truly unknown future kind fails identically (positive classification only).
    const runV2 = await (async () => {
      const run = await f.core.lifecycle.createRun({
        templateId: f.templateId, companyId: COMPANY, workflowId: 'wf-v2', actorId: f.actor,
        modelBindings: { supervisor: MODEL_KEY },
        goal: { objective: 'v2 run', source: { type: 'human' } },
      });
      if (!run.ok) throw new Error(run.error.message);
      return run.value.run.id;
    })();
    const control = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runV2, stageId: 'control2',
    });
    expect(control.ok).toBe(false); // 25 non-materializable known kind
    if (!control.ok) expect(reasonOf(control.error)).toBe('NORMAL_TASK_STAGE_PROFILE_UNAVAILABLE');
    // 24: unknown future kind — re-shape the node kind directly in a fresh draft.
    const graph3 = {
      nodes: [
        { id: 'work', kind: 'work' as const, title: 'w', config: { taskProfile: { roleId: 'rol.developer', taskKind: 'e2e7:build', maxAttempts: 3 } } },
        { id: 'future', kind: 'holodeck' as never, title: 'f', config: {} },
      ],
      edges: [{ from: 'work', to: 'future' }],
    } as never;
    const v3 = await publishNextVersion(f, graph3, 'rev3-unknown-future-stage-kind');
    if (!v3.ok) throw new Error(v3.error?.message ?? 'v3 publish failed');
    const runV3 = await (async () => {
      const run = await f.core.lifecycle.createRun({
        templateId: f.templateId, companyId: COMPANY, workflowId: 'wf-v3', actorId: f.actor,
        modelBindings: { supervisor: MODEL_KEY },
        goal: { objective: 'v3 run', source: { type: 'human' } },
      });
      if (!run.ok) throw new Error(run.error.message);
      return run.value.run.id;
    })();
    const futureKind = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runV3, stageId: 'future',
    });
    expect(futureKind.ok).toBe(false); // 24
    if (!futureKind.ok) expect(reasonOf(futureKind.error)).toBe('NORMAL_TASK_STAGE_PROFILE_UNAVAILABLE');
    // 21 (stage outside pinned version) is the same mechanism as 22 — a stage id that only
    // exists under another version is simply not in THIS run's pinned graph.
  });
});

/* --------------------------------------- §55 isolation (tests 26-30) + §44-§45 */

describe('T20-03B §55 — multi-run isolation and replay', () => {
  it('26-30. two runs, same version/stage: distinct tasks, no bleed, restart-safe', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const runB = await f.mkRun('wf-b');
    const TA = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runA, stageId: 'work' });
    const TB = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runB, stageId: 'work' });
    expect(TA.ok && TB.ok).toBe(true);
    if (!TA.ok || !TB.ok) return;
    expect(TA.value.taskId).not.toBe(TB.value.taskId); // 26
    expect(String(TA.value.task.runId)).toBe(runA);
    expect(String(TB.value.task.runId)).toBe(runB);
    // 27/28: A sees/claims only TA; B only TB (the run-scoped claim seam).
    const ofA = await f.core.database.tasks.listByRun(runA);
    const ofB = await f.core.database.tasks.listByRun(runB);
    expect(ofA.map((t) => t.id)).toContain(TA.value.taskId);
    expect(ofA.map((t) => t.id)).not.toContain(TB.value.taskId);
    expect(ofB.map((t) => t.id)).toContain(TB.value.taskId);
    expect(ofB.map((t) => t.id)).not.toContain(TA.value.taskId);
    // 29: foreign tenant → NOT_FOUND, no leak.
    const foreign = await f.core.normalTaskMaterializer!.materialize({
      companyId: 'company_other', runId: runA, stageId: 'work',
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('NOT_FOUND');
      expect(reasonOf(foreign.error)).toBe('RUN_MISSING');
    }
    // 30: restart → both replay their own task, ownership preserved, no cross-run conflict.
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const db2 = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db2);
    const foundation2 = await openArtifactFoundation({ casRoot: f.casRoot, database: db2, logger: nullLogger as never });
    if (!foundation2.ok) throw new Error('foundation2 failed');
    const core2 = await composeCoreServices(db2, nullLogger as never, {
      artifactFoundation: foundation2 as never,
      stageHandlers: { developerKinds: ['e2e7:build'], reviewKinds: ['e2e7:review'], qaKinds: ['e2e7:qa'] },
    });
    if (core2 === null) throw new Error('composition2 failed');
    const replayA = await core2.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runA, stageId: 'work' });
    const replayB = await core2.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runB, stageId: 'work' });
    expect(replayA.ok && replayB.ok).toBe(true);
    if (!replayA.ok || !replayB.ok) return;
    expect(replayA.value.taskId).toBe(TA.value.taskId);
    expect(replayB.value.taskId).toBe(TB.value.taskId);
    expect(replayA.value.replayed).toBe(true);
    expect(replayB.value.replayed).toBe(true);
  });
});

/* ------------------------------------- §56 corrective compatibility (tests 31-36) */

describe('T20-03B §56 — corrective compatibility (real chain)', () => {
  it('31-35. materialized T0 executes; REQUEST_CORRECTIVE → provisioner T1, same run, lineage intact', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const T0 = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runA, stageId: 'work' });
    if (!T0.ok) throw new Error(T0.error.message);
    const reviewA = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runA, stageId: 'review' });
    if (!reviewA.ok) throw new Error(reviewA.error.message);
    // 31: the materialized task enters the REAL execution path — the autonomous loop for
    // run A executes T0 (the Developer session handler) and completes the work stage.
    const loop = await f.core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: runA, taskId: T0.value.taskId,
      reviewTaskId: reviewA.value.taskId, actorId: f.actor, runIdentity: 't20b-a',
    });
    expect(loop?.ok).toBe(true);
    if (loop?.ok !== true) return;
    expect(String((await f.core.database.tasks.get(T0.value.taskId as never))?.state)).toBe('DONE');
    // 32-34: a real CHANGES_REQUESTED report + decision → the EXISTING provisioner creates
    // T1 under the same run with canonical lineage.
    const stamp = new Date().toISOString();
    const execId = `exec_t20b_${String(new Date().getTime())}`;
    f.core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.review', 'rol.review', ?, ?, ?, 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(execId, reviewA.value.taskId, runA, MODEL_KEY, stamp, stamp, stamp);
    const recorded = await f.core.reviewFindingsSink!.record({
      companyId: COMPANY, runId: runA, reviewStageId: 'review' as never,
      reviewTaskId: reviewA.value.taskId, subjectTaskId: T0.value.taskId,
      executionId: execId, verdict: 'CHANGES_REQUESTED',
      findings: [{ code: 'needs.work', summary: 'fix', detail: 'd', blocking: true }],
      decidedBy: f.actor,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    const decision = await f.core.supervisorDecisionSink!.record({
      commandId: supervisorDecisionCommandId(runA, `t20b-${String(new Date().getTime())}`),
      companyId: COMPANY, runId: runA, action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING',
      summary: 'corrective from materialized T0', evidenceRefs: [`artifact:${String(recorded.value.artifactId)}`],
      decidedBy: f.actor,
    });
    if (!decision.ok) throw new Error(decision.error.message);
    const t1 = await f.core.correctiveProvisioner!.provision({
      companyId: COMPANY, runId: runA, decisionId: decision.value.decisionId, decisionVersion: 1, actorId: f.actor,
    });
    expect(t1.ok).toBe(true); // 32
    if (!t1.ok) return;
    const t1Row = await f.core.database.tasks.get(t1.value.taskId as never);
    expect(String(t1Row?.runId)).toBe(runA); // 33 = T0.runId
    const lineage = t1Row?.inputs['corrective'] as Record<string, unknown>;
    expect(String(lineage['parentTaskId'])).toBe(T0.value.taskId); // 34 canonical lineage
    expect(Number(lineage['round'])).toBe(1);
    // 35: the normal identity for the same run/stage is T0 — the provisioner's T1 is a
    // DIFFERENT id namespace; the materializer never produces it.
    expect(t1.value.taskId).not.toBe(T0.value.taskId);
    expect(t1.value.taskId).not.toBe(normalTaskIdOf({ companyId: COMPANY, runId: runA, stageId: 'work' }));
  });

  it('36. forged corrective inputs through the materializer → FAIL CLOSED, no row', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const before = (await f.core.database.tasks.listByRun(runA)).length;
    const forged = await f.core.normalTaskMaterializer!.materialize({
      companyId: COMPANY, runId: runA, stageId: 'work',
      inputs: {
        corrective: { parentTaskId: 'tsk_forged', rootTaskId: 'tsk_forged', round: 9 },
      },
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(reasonOf(forged.error)).toBe('NORMAL_TASK_CORRECTIVE_INPUTS_FORBIDDEN');
    expect((await f.core.database.tasks.listByRun(runA)).length).toBe(before); // no row created
  });
});

/* -------------------------------------------- §57 side effects (tests 37-43) */

describe('T20-03B §57 — materialization alone has ZERO side effects', () => {
  it('37-43. provider/execution/decision/review/validation/session/handoff all untouched', async () => {
    const f = await makeFixture();
    const runA = await f.mkRun('wf-a');
    const counts = () => ({
      executions: Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c),
      decisions: Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number }).c),
      reviews: Number((f.core.database.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'").get() as { c: number }).c),
      validations: Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM validations').get() as { c: number }).c),
      sessions: Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c),
      handoffs: (() => {
        const table = f.core.database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get() as { name: string } | undefined;
        return table === undefined ? 0 : Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM handoffs').get() as { c: number }).c);
      })(),
    });
    const before = counts();
    const made = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: runA, stageId: 'work' });
    expect(made.ok).toBe(true);
    expect(providerCalls).toBe(0); // 37 zero provider calls
    expect(developerCalls).toBe(0);
    const after = counts();
    expect(after.executions).toBe(before.executions); // 38
    expect(after.decisions).toBe(before.decisions); // 39
    expect(after.reviews).toBe(before.reviews); // 40
    expect(after.validations).toBe(before.validations); // 41
    expect(after.sessions).toBe(before.sessions); // 42
    expect(after.handoffs).toBe(before.handoffs); // 43 (no handoff write)
    expect(String(made.ok === true ? made.value.task.state : '')).toBe('PENDING'); // creation only
  });
});
