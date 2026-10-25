// H12 — restart consistency through the REAL production composition (in-process, three
// compositions on ONE dataDir). The cross-process proof on the installed app is
// scripts/hark/restart-unknown.mjs (+ .github/workflows/hark-restart.yml); this keeps the
// same contract in the regular gate. Counting fake provider only: no network, CNY 0.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { productionCompositionOptions } from '../../apps/desktop/src/production-composition.js';
import { createDeploymentBudgetProofSource } from '../../apps/desktop/src/deployment-budget-proof.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const root = mkdtempSync(join(tmpdir(), 'companyos-h12-'));
const dataDir = join(root, 'data');
const budgetDir = join(root, 'budget');
const dbs: DurableDatabase[] = [];
afterAll(() => { for (const db of dbs) { try { db.close(); } catch { /* already closed */ } } rmSync(root, { recursive: true, force: true }); });

// Same bytes scripts/hark/make-budget-approval.mjs writes (the offline guard forbids spawning it).
const writeApproval = (): void => {
  const t = JSON.parse(readFileSync('scripts/hark/fixtures/h12-counting-fake.approval-template.json', 'utf8')) as { approvedBy: string; currency: string; billingScope: unknown; cap: unknown; proof: { identity: unknown; pricing: unknown; tokens: unknown; validForMs: number } };
  const now = Date.now();
  const proof = { schema: 'companyos:trusted-budget-proof:1', scope: 'PRODUCTION_VERIFIED', identity: t.proof.identity, pricing: t.proof.pricing, tokens: t.proof.tokens, validFromMs: now - 60_000, validUntilMs: now + t.proof.validForMs };
  const bytes = Buffer.from(JSON.stringify(proof));
  const hex = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(budgetDir, 'proofs'), { recursive: true });
  writeFileSync(join(budgetDir, 'proofs', `${hex}.json`), bytes);
  writeFileSync(join(budgetDir, 'approvals.json'), JSON.stringify({ schema: 'companyos:budget-approval:1', approvedBy: t.approvedBy, approvedAt: new Date(now).toISOString(), currency: t.currency, billingScope: t.billingScope, cap: t.cap, proofs: [`sha256:${hex}`] }));
};

let calls = 0;
const fake = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'h12.counting-fake', kind: 'fake', displayName: 'h12', version: '1' }),
  listModels: () => Promise.resolve(ok([{ modelId: 'fake-1', displayName: 'fake-1', contextWindow: 32768, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke: () => { calls += 1; return new Promise(() => { /* never answers */ }); },
  stream(): AsyncIterable<Result<never, DomainError>> { return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }; },
});

const compose = async (first: boolean) => {
  const deployment = createDeploymentBudgetProofSource(budgetDir);
  if (deployment === undefined) throw new Error('no approval');
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  dbs.push(db);
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions({ COS_PLAN_PREVIEW_WITHOUT_EXECUTOR: '1' }, { trustedBudgetProofs: deployment.source, budgetCap: deployment.cap }),
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: mkdtempSync(join(root, 'ws-')), commandProfile: {} });
  if (!opened.ok) throw new Error(opened.error.message);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(fake(), { actorId: actor });
  if (first) {
    await core.models.registerFromProvider({ providerId: 'h12.counting-fake', providerModelId: 'fake-1', modelKey: 'h12.fake', actorId: actor });
    const saved = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'h12.fake', actorId: actor } as never);
    if (!saved.ok) throw new Error(saved.error.message);
  }
  const budget = (runId: string) => JSON.parse((db.db.prepare('SELECT execution_budget_json AS b FROM runs WHERE id = ?').get(runId) as { b: string }).b) as { cancellation: unknown; reservations: { status: string; usage: unknown; bound: { costMicros: number } }[] };
  const run = (runId: string) => db.db.prepare('SELECT state, history_json AS h FROM runs WHERE id = ?').get(runId) as { state: string; h: string };
  const view = async (runId: string) => ((await core.controlPlane!.handle({ operation: 'run.budget', payload: { companyId: COMPANY, runId } })).value as { budget: { state: string; unknown: { calls: number; costMicros: number }; held: { calls: number } } }).budget;
  return { core, budget, run, view };
};

const db0 = (core: { database: { db: { prepare(sql: string): { get(...p: unknown[]): unknown } } } }) => core.database.db;
const outcomeOf = async (core: { controlPlane: unknown }, runId: string): Promise<string | null> => {
  const read = await (core.controlPlane as { handle(r: unknown): Promise<{ ok: boolean; value?: unknown }> }).handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId } });
  if (!read.ok) throw new Error('goal.workspace failed');
  return (read.value as { overview: { terminalOutcome: string | null } }).overview.terminalOutcome;
};

describe('H12 restart: admitted-but-unsettled call is UNKNOWN, never replayed; cancel terminals survive', () => {
  let goalA = '';
  let goalB = '';
  let bHistory = '';
  it('R1 first composition leaves one RESERVED call in flight', async () => {
    writeApproval();
    const { core, budget, run, view } = await compose(true);
    goalA = String(((await core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '整理三项物资清单。', commandId: 'h12-a' } })).value as { runId: string }).runId);
    goalB = String(((await core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '取消对照。', commandId: 'h12-b' } })).value as { runId: string }).runId);
    expect((await core.controlPlane!.handle({ operation: 'goal.cancel', payload: { companyId: COMPANY, runId: goalB } })).ok).toBe(true);
    void core.autonomyDriver!.run({ companyId: COMPANY, runId: goalA });
    for (let i = 0; i < 300 && !(calls === 1 && budget(goalA).reservations[0]?.status === 'RESERVED'); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    expect(budget(goalA).reservations.map((r) => r.status)).toEqual(['RESERVED']);
    expect((await view(goalA)).held.calls).toBe(1);
    // Core run-state: CANCEL -> FAILED with the CANCEL history event (no separate state).
    for (let i = 0; i < 60 && run(goalB).state !== 'FAILED'; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(run(goalB).state).toBe('FAILED');
    expect((JSON.parse(run(goalB).h) as { event: string }[]).at(-1)?.event).toBe('CANCEL');
    bHistory = run(goalB).h;
    // H12b: the cancelled terminal is TYPED (failureReason cancelled → terminalOutcome CANCELLED).
    expect((db0(core).prepare('SELECT failure_reason AS r FROM runs WHERE id = ?').get(goalB) as { r: string }).r).toBe('cancelled');
    expect(await outcomeOf(core, goalB)).toBe('CANCELLED');
  });

  it('R2 reopen: recovery => UNKNOWN at bound; advance refused GOAL_USAGE_UNKNOWN; 0 provider calls', async () => {
    calls = 0;
    const { core, budget, run, view } = await compose(false);
    const r = budget(goalA).reservations;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: 'UNKNOWN', usage: null, bound: { costMicros: 112000 } });
    const adv = await core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalA } });
    expect(adv.ok).toBe(false);
    expect((adv.error?.details as { reason?: string }).reason).toBe('GOAL_USAGE_UNKNOWN');
    await core.autonomyDriver!.run({ companyId: COMPANY, runId: goalA });
    expect(calls).toBe(0);
    expect(budget(goalA).reservations).toHaveLength(1);
    const v = await view(goalA);
    expect(v.unknown).toMatchObject({ calls: 1, costMicros: 112000 });
    expect(v.held.calls).toBe(0);
    expect((await core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalB } })).ok).toBe(false);
    expect(run(goalB).h).toBe(bHistory);
    expect((await core.controlPlane!.handle({ operation: 'goal.cancel', payload: { companyId: COMPANY, runId: goalA } })).ok).toBe(true);
  });

  it('R3 reopen again: cancelled terminals unchanged, UNKNOWN still counted, 0 calls', async () => {
    calls = 0;
    const { core, budget, run, view } = await compose(false);
    const historyA = run(goalA).h;
    const adv = await core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalA } });
    expect(adv.ok).toBe(false);
    expect(adv.error?.code).toBe('CANCELLED');
    await core.autonomyDriver!.run({ companyId: COMPANY, runId: goalA });
    expect(calls).toBe(0);
    expect(run(goalA).h).toBe(historyA);
    expect(run(goalB).h).toBe(bHistory);
    expect(budget(goalA).cancellation).not.toBeNull();
    expect(budget(goalA).reservations.map((x) => x.status)).toEqual(['UNKNOWN']);
    const v = await view(goalA);
    expect(v.state).toBe('CANCELLED');
    expect(v.unknown.calls).toBe(1);
    // H12b: after two restarts B is still the typed CANCELLED terminal.
    expect(await outcomeOf(core as never, goalB)).toBe('CANCELLED');
  });
});
