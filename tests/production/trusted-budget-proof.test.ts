import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createFilesystemArtifactContentStore, openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import type { ArtifactContentStore } from '@companyos/core';
import type { SelectedModelRoute } from '@companyos/engine';
import { createExecutionSafetyCoordinator, type GoalSafetyConfiguration } from '../../apps/desktop/src/execution-safety-coordinator.js';
import { pinnedBudgetCost, readTrustedBudgetProof, type TrustedBudgetProof, type TrustedBudgetProofSource, type VerifiedBudgetIdentity } from '../../apps/desktop/src/trusted-budget-proof.js';
import { productionCompositionOptions } from '../../apps/desktop/src/production-composition.js';

// TEST ONLY: synthetic identity/price approvals. No Provider/Kernel is constructed.
// Approvals, selector and CAS bytes are real local files, reopened after a simulated crash.
const dirs: string[] = [], databases: DurableDatabase[] = [], handles: { release(): void }[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.release();
  while (databases.length) databases.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const identity: VerifiedBudgetIdentity = {
  providerId: 'TEST_ONLY:provider', modelId: 'TEST_ONLY:model', upstreamModelIdentity: 'TEST_ONLY:attested-model',
  endpoint: 'http://127.0.0.1:1/v1', routingIdentity: 'TEST_ONLY:route-v1', credentialRef: 'vault://TEST_ONLY/account/key',
  billingAccount: 'TEST_ONLY:account', billingOrganization: 'TEST_ONLY:org', attestationRef: 'TEST_ONLY:identity-approval',
};
const proofOf = (over: Partial<TrustedBudgetProof> = {}): TrustedBudgetProof => ({
  schema: 'companyos:trusted-budget-proof:1', scope: 'TEST_ONLY', identity,
  pricing: { source: 'TEST_ONLY:tariff', version: 'v1', currency: 'CNY', units: 'MICROS_PER_MILLION_TOKENS',
    rounding: 'CEIL_TOTAL_PER_REQUEST_MICROS', inputRate: 1000000, outputRate: 1000000 },
  tokens: { inputUpperBound: 30, outputUpperBound: 10, evidenceRef: 'TEST_ONLY:enforced-token-limit' },
  validFromMs: 0, validUntilMs: 200000, ...over,
});
const route: SelectedModelRoute = { modelProfileId: 'TEST_ONLY:key', providerId: identity.providerId, modelId: identity.modelId,
  baseURL: identity.endpoint, credentialRef: identity.credentialRef, contextWindow: 40, maxTokens: 10, configurationVersion: 1 };

const fixture = async (options: { maxCalls?: number; maxTokens?: number; maxCostMicros?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-budget-')); dirs.push(dir);
  const casRoot = join(dir, 'cas'); mkdirSync(casRoot);
  const time = { now: 1000 };
  const jsonWrite = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value), 'utf8');
  jsonWrite('approvals.json', []); jsonWrite('identity.json', identity);
  const open = () => { const db = openDurableDatabase({ dataDir: join(dir, 'db'), appliedAt: '2026-10-24T00:00:00Z' }); databases.push(db); return db; };
  const db = open();
  db.db.prepare(`INSERT INTO runs (id,company_id,workflow_id,template_id,version_id,snapshot_id,state,revision,rework_count,max_rework,history_json,created_at,updated_at,started_by) VALUES ('goal','company','workflow','template','version','snapshot','IDLE',0,0,3,'[]','1970-01-01T00:00:01Z','now','actor')`).run();
  const store = () => createFilesystemArtifactContentStore({ casRoot });
  const source = (content: Pick<ArtifactContentStore, 'get'> = store()): TrustedBudgetProofSource => ({
    scope: 'TEST_ONLY', policyId: 'TEST_ONLY/CNY/policy-v1', currency: 'CNY', billingScope: { providerId: identity.providerId, account: identity.billingAccount, organization: identity.billingOrganization }, store: content,
    identify: async () => JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8')) as VerifiedBudgetIdentity,
    approved: async ref => (JSON.parse(readFileSync(join(dir, 'approvals.json'), 'utf8')) as string[]).includes(ref),
    select: async () => JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')) as string | null,
  });
  const publish = async (proof: unknown) => {
    const saved = await store().put(Buffer.from(JSON.stringify(proof), 'utf8'));
    const approved = JSON.parse(readFileSync(join(dir, 'approvals.json'), 'utf8')) as string[];
    jsonWrite('approvals.json', [...approved, saved.contentRef]); jsonWrite('current.json', saved.contentRef);
    return saved.contentRef;
  };
  const originalRef = await publish(proofOf());
  const config = (trustedProofs = source()): GoalSafetyConfiguration => ({ trustedProofs, policyId: trustedProofs.policyId,
    maxCalls: options.maxCalls ?? 4, maxTokens: options.maxTokens ?? 1000, maxCostMicros: options.maxCostMicros ?? 1000, durationMs: 100000 });
  const safety = createExecutionSafetyCoordinator(db, config(), () => time.now);
  await safety.initialize('goal');
  const start = async (id: string, selected = route, coordinator = safety) => {
    const transport = await coordinator.prepareExecutor({ runId: 'goal', attemptId: id, route: selected }); handles.push(transport);
    return { transport, send: async () => { const call = await transport.admitBody(Buffer.from(JSON.stringify({ model: selected.modelId, max_tokens: selected.maxTokens }))); handles.push(call); return call; } };
  };
  const reserve = async (id: string, selected = route, coordinator = safety) => (await start(id, selected, coordinator)).send();
  return { dir, db, open, store, source, config, safety, time, start, reserve, publish, originalRef, jsonWrite };
};
const denied = { code: 'POLICY_DENIED' };

it('TEST ONLY valid proof is persisted in the original reservation and settled from actual token usage', async () => {
  const f = await fixture(); const call = await f.reserve('a');
  const reservation = (await f.safety.budget.read('goal')).reservations[0]!;
  expect(reservation).toMatchObject({ ownerId: 'a', callId: 'a:network:1', bound: { evidenceRef: f.originalRef, costMicros: 40 } });
  await call.settle({ inputTokens: 2, outputTokens: 3, totalCost: null });
  expect((await f.safety.budget.read('goal')).reservations[0]).toMatchObject({ status: 'KNOWN', usage: { tokens: 5, costMicros: 5 } });
});

it.each(['providerId', 'modelId', 'upstreamModelIdentity', 'endpoint', 'routingIdentity', 'credentialRef', 'billingAccount', 'billingOrganization', 'attestationRef'] as const)('rejects mismatched verified %s', async key => {
  const f = await fixture();
  f.jsonWrite('identity.json', { ...identity, [key]: key === 'endpoint' ? 'http://127.0.0.1:1/other' : 'TEST_ONLY:wrong' });
  await expect(f.start('wrong')).rejects.toMatchObject(denied);
  expect((await f.safety.budget.read('goal')).reservations).toHaveLength(0);
});
it.each(['providerId', 'modelId', 'baseURL', 'credentialRef'] as const)('rejects actual executor %s mismatch even with the same logical key', async key => {
  const f = await fixture();
  await expect(f.start('actual-wrong', { ...route, [key]: key === 'baseURL' ? 'http://127.0.0.1:1/wrong' : 'TEST_ONLY:wrong' })).rejects.toMatchObject(denied);
});
it.each(['missing', 'expired', 'future', 'token', 'currency', 'units', 'rounding', 'production-scope'] as const)('rejects %s proof without legacy fallback', async mode => {
  const f = await fixture(); const p = proofOf();
  if (mode === 'missing') f.jsonWrite('current.json', null);
  else await f.publish(mode === 'expired' ? { ...p, validUntilMs: 1000 }
    : mode === 'future' ? { ...p, validFromMs: 1001 }
    : mode === 'token' ? { ...p, tokens: { outputUpperBound: 10, evidenceRef: 'TEST_ONLY' } }
    : mode === 'currency' ? { ...p, pricing: { ...p.pricing, currency: 'USD' } }
    : mode === 'units' ? { ...p, pricing: { ...p.pricing, units: 'UNVERIFIED_UNITS' } }
    : mode === 'rounding' ? { ...p, pricing: { ...p.pricing, rounding: 'GUESSED' } }
    : { ...p, scope: 'PRODUCTION_VERIFIED' });
  const configured = createExecutionSafetyCoordinator(f.db, { ...f.config(), boundOf: () => ({ modelKey: route.modelProfileId, inputTokens: 0, outputTokens: 10, costMicros: 0, evidenceRef: 'UNSAFE_FALLBACK', validUntilMs: 99999 }) }, () => f.time.now);
  await expect(f.start('invalid', route, configured)).rejects.toMatchObject(denied);
});
it('rejects absent identity, expired approval, unknown reference scheme, and oversized output', async () => {
  const f = await fixture(); f.jsonWrite('identity.json', null); await expect(f.start('no-identity')).rejects.toMatchObject(denied);
  f.jsonWrite('identity.json', identity); f.jsonWrite('approvals.json', []); await expect(f.start('not-approved')).rejects.toMatchObject(denied);
  f.jsonWrite('approvals.json', ['https://untrusted.invalid/proof']); f.jsonWrite('current.json', 'https://untrusted.invalid/proof'); await expect(f.start('external-ref')).rejects.toMatchObject(denied);
  await f.publish(proofOf()); await expect(f.start('too-large', { ...route, maxTokens: 11 })).rejects.toMatchObject(denied);
});
it.each([{ maxTokens: 39 }, { maxCostMicros: 39 }])('keeps canonical budget exhaustion %j', async options => {
  const f = await fixture(options); await expect(f.reserve('over-budget')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } });
});
it('pinned v1 settlement ignores current v2 prices and concurrent calls retain separate references', async () => {
  const f = await fixture(); const a = await f.reserve('a');
  const p = proofOf(); const next = await f.publish({ ...p, pricing: { ...p.pricing, version: 'v2', inputRate: 3000000, outputRate: 5000000 } });
  const b = await f.reserve('b');
  await Promise.all([b.settle({ inputTokens: 2, outputTokens: 3, totalCost: null }), a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null })]);
  const rows = (await f.safety.budget.read('goal')).reservations;
  expect(rows.map(r => [r.bound.evidenceRef, r.usage?.costMicros])).toEqual([[f.originalRef, 5], [next, 21]]);
  f.jsonWrite('current.json', null);
  await a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null });
  await expect(a.settle({ inputTokens: 3, outputTokens: 3, totalCost: null })).rejects.toMatchObject({ details: { reason: 'GOAL_SETTLEMENT_CONFLICT' } });
});
it('original proof remains usable for accounting after expiry but cannot admit a new request', async () => {
  const f = await fixture(); const a = await f.reserve('a'); f.time.now = 200001;
  await expect(a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null })).rejects.toMatchObject({ details: { reason: 'GOAL_DEADLINE_EXCEEDED' } });
  expect((await f.safety.budget.read('goal')).reservations[0]?.usage?.costMicros).toBe(5);
  await expect(f.start('expired')).rejects.toMatchObject(denied);
});
it('a latest-price payload returned for the pinned reference cannot settle as known', async () => {
  const f = await fixture(); let substitute = false;
  const p = proofOf(); const newRef = await f.publish({ ...p, pricing: { ...p.pricing, version: 'v2', inputRate: 3000000 } });
  f.jsonWrite('current.json', f.originalRef);
  const reader = { get: async (ref: string) => f.store().get(substitute ? newRef : ref) };
  const c = createExecutionSafetyCoordinator(f.db, f.config(f.source(reader)), () => f.time.now);
  const a = await f.reserve('a', route, c); substitute = true;
  await a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null });
  expect((await c.budget.read('goal')).reservations[0]?.status).toBe('UNKNOWN');
});
it.each(['usage', 'proof'])('missing original %s retains UNKNOWN and never substitutes zero/latest cost', async missing => {
  const f = await fixture(); const a = await f.reserve('a');
  if (missing === 'proof') f.jsonWrite('approvals.json', []);
  await a.settle(missing === 'usage' ? null : { inputTokens: 2, outputTokens: 3, totalCost: 0 });
  expect((await f.safety.budget.read('goal')).reservations[0]).toMatchObject({ status: 'UNKNOWN', usage: null, bound: { costMicros: 40 } });
  await expect(f.start('after-unknown')).rejects.toMatchObject({ details: { reason: 'GOAL_USAGE_UNKNOWN' } });
});
it('real database and CAS reopen preserve the original proof while recovery remains UNKNOWN', async () => {
  const f = await fixture(); await f.reserve('crash');
  const p = proofOf(); await f.publish({ ...p, pricing: { ...p.pricing, version: 'v2', inputRate: 9000000 } });
  while (handles.length) handles.pop()!.release(); databases.splice(databases.indexOf(f.db), 1); f.db.close();
  const reopened = f.open(); const source = f.source(f.store());
  const recovered = createExecutionSafetyCoordinator(reopened, f.config(source), () => f.time.now);
  await recovered.recover();
  const original = (await recovered.budget.read('goal')).reservations[0]!;
  expect(original).toMatchObject({ status: 'UNKNOWN', bound: { evidenceRef: f.originalRef, costMicros: 40 } });
  expect((await readTrustedBudgetProof(source, original.bound.evidenceRef))?.pricing.version).toBe('v1');
  expect(await pinnedBudgetCost(source, original, { inputTokens: 2, outputTokens: 3, totalCost: null })).toBe(5);
  await expect(recovered.budget.settle('goal', original.callId, { tokens: 5, costMicros: 5 })).rejects.toMatchObject({ details: { reason: 'GOAL_SETTLEMENT_CONFLICT' } });
  await expect(f.start('no-replay', route, recovered)).rejects.toMatchObject({ details: { reason: 'GOAL_USAGE_UNKNOWN' } });
});
it('retry physical calls count separately, duplicate reservation is refused, cancellation retains known cost', async () => {
  const f = await fixture({ maxCalls: 2 }); const transport = await f.start('same-attempt');
  const first = await transport.send(); await first.settle({ inputTokens: 1, outputTokens: 1, totalCost: null });
  const second = await transport.send(); await second.settle({ inputTokens: 2, outputTokens: 1, totalCost: null });
  await expect(transport.send()).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } });
  const g = await fixture(); const pending = await g.reserve('cancel');
  await expect(g.reserve('cancel')).rejects.toMatchObject({ details: { reason: 'GOAL_CALL_ALREADY_RESERVED' } });
  await g.safety.requestCancel('goal');
  await expect(pending.settle({ inputTokens: 2, outputTokens: 3, totalCost: null })).rejects.toMatchObject({ details: { reason: 'GOAL_CANCEL_REQUESTED' } });
  expect((await g.safety.budget.read('goal')).reservations[0]?.usage?.costMicros).toBe(5);
  await expect(g.start('after-cancel')).rejects.toMatchObject({ details: { reason: 'GOAL_CANCEL_REQUESTED' } });
});
it('production defaults remain fail-closed and TEST ONLY authority cannot enable them', async () => {
  const f = await fixture();
  expect(() => productionCompositionOptions({}, { trustedBudgetProofs: f.source() })).toThrow('TEST_ONLY');
  const production = productionCompositionOptions({}).executionSafety!;
  expect(production.trustedProofs).toBeUndefined(); expect(production.boundOf).toBeUndefined(); expect(production.maxCostMicros).toBe(0);
  const c = createExecutionSafetyCoordinator(f.db, production, () => f.time.now);
  await expect(c.prepareExecutor({ runId: 'goal', attemptId: 'production-denied', route })).rejects.toMatchObject(denied);
  const unbackedProductionSource = { ...f.source(), scope: 'PRODUCTION_VERIFIED' as const };
  expect(productionCompositionOptions({}, { trustedBudgetProofs: unbackedProductionSource }).executionSafety?.trustedProofs).toBe(unbackedProductionSource);
  expect(await readTrustedBudgetProof(unbackedProductionSource, f.originalRef)).toBeNull();
});
it('Agent admission reads the canonical execution binding rather than trusting a supplied logical label', async () => {
  const f = await fixture();
  // A synthetic store port isolates this identity branch; real durable budget/CAS remain in use.
  const fakeExecution = { runId: 'goal', modelKey: route.modelProfileId, providerId: identity.providerId, providerModelId: identity.modelId };
  const inputDb = { ...f.db, agentExecutions: { get: async () => fakeExecution } } as unknown as DurableDatabase;
  const c = createExecutionSafetyCoordinator(inputDb, f.config(), () => f.time.now);
  const a = await c.admit({ runId: 'goal', executionId: 'agent', modelKey: route.modelProfileId, networkAttempt: 1, maxOutputTokens: 10 }); handles.push(a);
  await a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null });
  fakeExecution.providerModelId = 'TEST_ONLY:other-model';
  await expect(c.admit({ runId: 'goal', executionId: 'agent', modelKey: route.modelProfileId, networkAttempt: 2, maxOutputTokens: 10 })).rejects.toMatchObject(denied);
  expect((await c.budget.read('goal')).reservations).toHaveLength(1);
});
it.each(['currency', 'billing-account'] as const)('persisted policy identity refuses %s replacement on the same Goal', async change => {
  const f = await fixture(); const original = await f.safety.budget.read('goal');
  const source = change === 'currency' ? { ...f.source(), currency: 'USD' }
    : { ...f.source(), billingScope: { ...f.source().billingScope, account: 'TEST_ONLY:other-account' } };
  const changed = createExecutionSafetyCoordinator(f.db, f.config(source), () => f.time.now);
  await expect(changed.initialize('goal')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_POLICY_CONFLICT' } });
  await expect(f.start('changed-policy', route, changed)).rejects.toMatchObject(denied);
  expect((await f.safety.budget.read('goal')).policy).toEqual(original.policy);
  expect(original.policy.policyId).toMatch(/^proof-policy:[0-9a-f]{64}$/u);
});
it('concurrent trusted requests cannot overrun the canonical physical call limit', async () => {
  const f = await fixture({ maxCalls: 1 });
  const settled = await Promise.allSettled([f.reserve('a'), f.reserve('b')]);
  expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await f.safety.budget.read('goal')).reservations).toHaveLength(1);
});
it('bounded integer tariff arithmetic follows the attested rounding rule, not provider totalCost', async () => {
  const f = await fixture(); const p = proofOf();
  await f.publish({ ...p, pricing: { ...p.pricing, inputRate: 100000, outputRate: 250000 } });
  const a = await f.reserve('fraction'); await a.settle({ inputTokens: 1, outputTokens: 1, totalCost: 999999 });
  const row = (await f.safety.budget.read('goal')).reservations[0]!;
  expect(row.bound.costMicros).toBe(6); expect(row.usage?.costMicros).toBe(1);
});
it('trusted fallback with incomplete endpoint/credential identity cannot start the executor', async () => {
  const f = await fixture();
  await expect(f.safety.prepareExecutor({ runId: 'goal', attemptId: 'fallback', fallback: { providerId: identity.providerId, modelId: identity.modelId, maxTokens: 10 } })).rejects.toMatchObject({ details: { reason: 'GOAL_ADMISSION_IDENTITY_UNPROVEN' } });
});
it('unavailable canonical AgentExecution denies without inventing identity from the key', async () => {
  const f = await fixture();
  const inputDb = { ...f.db, agentExecutions: { get: async () => null } } as unknown as DurableDatabase;
  const c = createExecutionSafetyCoordinator(inputDb, f.config(), () => f.time.now);
  await expect(c.admit({ runId: 'goal', executionId: 'missing', modelKey: route.modelProfileId, networkAttempt: 1, maxOutputTokens: 10 })).rejects.toMatchObject(denied);
  expect((await c.budget.read('goal')).reservations).toHaveLength(0);
});
it('the price selector cannot change the attested identity after matching the observed binding', async () => {
  const f = await fixture();
  const alternate = await f.publish(proofOf({ identity: { ...identity, upstreamModelIdentity: 'TEST_ONLY:different-upstream' } }));
  const source: TrustedBudgetProofSource = { ...f.source(), select: async actual => {
    Object.assign(actual, { upstreamModelIdentity: 'TEST_ONLY:different-upstream' });
    return alternate;
  } };
  const c = createExecutionSafetyCoordinator(f.db, f.config(source), () => f.time.now);
  await expect(f.start('mutation', route, c)).rejects.toMatchObject(denied);
  expect((await c.budget.read('goal')).reservations).toHaveLength(0);
});
it('concurrent duplicate callbacks settle once and a conflicting later callback is refused', async () => {
  const f = await fixture(); const a = await f.reserve('duplicate');
  await Promise.all([a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null }), a.settle({ inputTokens: 2, outputTokens: 3, totalCost: null })]);
  expect((await f.safety.budget.read('goal')).reservations).toHaveLength(1);
  expect((await f.safety.budget.read('goal')).reservations[0]?.usage?.costMicros).toBe(5);
  await expect(a.settle(null)).rejects.toMatchObject({ details: { reason: 'GOAL_SETTLEMENT_CONFLICT' } });
});
