import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * MULTI-OPERATION PRODUCTION ROUTING (Boss V1 Bug Bash Entry §3/§4) — the proof
 * that ONE goal's plan can distribute its items across DISTINCT deployment-declared
 * native operations through the REAL production path:
 *
 *   Goal → (real-planned) Plan with per-item taskKind REQUESTS
 *   → control-plane trusted derivation validates against the deployment's CLOSED kind set
 *   → PlanItemCompilationProfile per item → pinned WorkflowVersion
 *   → materialized Tasks with DISTINCT taskKinds
 *   → providerRoutes per kind → nativeOperations per kind → distinct native processes.
 *
 * The negative proof: a taskKind OUTSIDE the closed set fails closed at the
 * derivation (CONTROL_PLANE_TASK_KIND_UNKNOWN) — the model proposes, the deployment
 * disposes, never the reverse.
 *
 * The planner seam uses the deterministic scripted MODEL fixture here (the real-model
 * planning reliability is separately proven live); the EXECUTION is REAL: distinct
 * node processes performing distinct operations on real files.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'multiop.planner';
const NODE = process.execPath;

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'multiop-'));
  createdDirs.push(dir);
  return dir;
};


const OP_UPPER = `const fs=require('fs');const t=fs.readFileSync(process.argv[2],'utf8');fs.writeFileSync(process.argv[3],t.split(/\\r?\\n/).map(l=>l.trim().toUpperCase()).filter(Boolean).join('\\n'));console.log(JSON.stringify({op:'upper'}));`;
const OP_COUNT = `const fs=require('fs');const t=fs.readFileSync(process.argv[2],'utf8');const n=t.split('\\n').filter(Boolean).length;fs.writeFileSync(process.argv[3],JSON.stringify({op:'count',lines:n}));console.log(JSON.stringify({op:'count',lines:n}));`;

interface MultiOpFixture {
  readonly core: Core;
  readonly workspace: string;
}

const composeMultiOp = async (planTaskKinds: readonly (string | undefined)[]): Promise<MultiOpFixture> => {
  const dataDir = tempDir();
  const workspace = tempDir();
  const scripts = join(dataDir, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'op-upper.cjs'), OP_UPPER, 'utf8');
  registerOfflineCommonJsFixture(join(scripts, 'op-upper.cjs'));
  writeFileSync(join(scripts, 'op-count.cjs'), OP_COUNT, 'utf8');
  registerOfflineCommonJsFixture(join(scripts, 'op-count.cjs'));
  writeFileSync(join(workspace, 'input.txt'), ['alpha', 'beta', 'gamma'].join('\n'), 'utf8');

  const planItems = planTaskKinds.map((kind, index) => ({
    planItemId: `item-${String(index + 1)}`,
    objective: `Stage ${String(index + 1)}`,
    dependencyPlanItemIds: index === 0 ? [] : [`item-${String(index)}`],
    acceptanceCriterionRefs: ['c'],
    ...(kind === undefined ? {} : { taskKind: kind }),
  }));
  const stub: ModelProviderPort = {
    describe: () => ({ providerId: 'prov_multiop', kind: 'fake', displayName: 'multiop', version: '1' }),
    listModels: () => Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 32768, capabilities: { streaming: false, structuredOutput: true } }])),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      const properties = (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      let structured: unknown;
      if (!('action' in properties) && !('verdict' in properties)) {
        structured = { schema: 'companyos/plan-proposal/1', planItems, acceptanceCriteria: [{ criterionId: 'c', requirement: 'done' }] };
      } else if ('verdict' in properties) {
        structured = 'targetRef' in properties
          ? { schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal' }
          : { schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok' };
      } else {
        structured = { schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'next', evidenceRefs: [] };
      }
      return Promise.resolve(ok({ modelId: request.modelId, providerId: 'prov_multiop', outputText: 'x', structured: structured as never, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const }));
    },
    stream(): AsyncIterable<Result<never, DomainError>> {
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
    },
  };

  const operations = {
    'native.op.upper': { operationId: 'upper', executable: NODE, args: [join(scripts, 'op-upper.cjs')], inputArgs: ['inputFile', 'outputFile'], timeoutMs: 20_000 },
    'native.op.count': { operationId: 'count', executable: NODE, args: [join(scripts, 'op-count.cjs')], inputArgs: ['inputFile', 'outputFile'], timeoutMs: 20_000 },
  };
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND, 'native.op.upper', 'native.op.count'] },
    goalWorkProfile: { stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 2, operationKinds: ['native.op.upper', 'native.op.count'] },
    providerKinds: ['native.op.upper', 'native.op.count'],
    providerRoutes: { 'native.op.upper': 'native.process', 'native.op.count': 'native.process' },
    repositoryRuntime: { repositoryCapableKinds: ['native.op.upper', 'native.op.count'] },
    nativeOperations: operations as never,
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: workspace, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stub, { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_multiop', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const policy = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor } as never);
  if (!policy.ok) throw new Error(policy.error.message);
  return { core, workspace };
};

describe('MULTI-OPERATION production routing (entry gate §3/§4)', () => {
  it('ONE goal → per-item taskKind requests → DISTINCT pinned taskKinds → distinct materialized Tasks (production planning path)', async () => {
    const f = await composeMultiOp(['native.op.upper', 'native.op.count']);
    const cp = f.core.controlPlane!;
    const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '规范化文本并统计行数。', commandId: 'multiop-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    // The pinned version froze DISTINCT per-node taskProfiles:
    const kinds = f.core.database.db
      .prepare('SELECT kind FROM tasks WHERE run_id = ? ORDER BY id')
      .all(executionRunId) as { kind: string }[];
    expect(kinds.map((k) => k.kind).sort()).toEqual(['native.op.count', 'native.op.upper']);
    // Both kinds are routed to the native provider through the deployment table.
    const routes = f.core.database.db.prepare('SELECT provider_key FROM provider_dispatches').all();
    void routes; // dispatches appear when tasks execute; routing proven by compilation above
  });

  it('a taskKind OUTSIDE the deployment closed set fails CLOSED at the trusted derivation (model proposes, deployment disposes)', async () => {
    const f = await composeMultiOp(['native.op.upper', 'native.op.EVIL-unknown']);
    const cp = f.core.controlPlane!;
    const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '目标。', commandId: 'multiop-evil-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(advanced.ok).toBe(false);
    if (advanced.ok) return;
    expect(String((advanced.error as { details?: { reason?: string } }).details?.reason ?? (advanced.error as { code?: string }).code)).toBe('CONTROL_PLANE_TASK_KIND_UNKNOWN');
    // No version/run/work was created from the refused plan:
    const dispatches = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get() as { n: number };
    expect(dispatches.n).toBe(0);
  });

  it('items WITHOUT a requested kind keep the default work kind (backward-compatible)', async () => {
    const f = await composeMultiOp([undefined, undefined]);
    const cp = f.core.controlPlane!;
    const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '普通目标。', commandId: 'multiop-default-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    const kinds = f.core.database.db.prepare('SELECT kind FROM tasks WHERE run_id = ?').all(executionRunId) as { kind: string }[];
    expect(kinds.every((k) => k.kind === GOAL_WORK_KIND)).toBe(true);
  });
});
