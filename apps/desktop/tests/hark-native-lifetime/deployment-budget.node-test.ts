// H10 — deployment (operator-attested) trusted budget proof source. Offline, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDeploymentBudgetProofSource } from '../../src/deployment-budget-proof.ts';
import { readTrustedBudgetProof, trustedBudgetBound, trustedBudgetPolicyId } from '../../src/trusted-budget-proof.ts';

const NOW = Date.UTC(2026, 9, 25, 4, 0, 0);
const identity = {
  providerId: 'model.deepseek', modelId: 'deepseek-flash', upstreamModelIdentity: 'DeepSeek-V4.1-Flash-1017',
  endpoint: 'https://api.deepseek.com', routingIdentity: 'env:deepseek-flash', credentialRef: 'vault://COMPANYOS_MODEL_API_KEY/live',
  billingAccount: 'deepseek:operator', billingOrganization: null, attestationRef: 'operator-approval:test',
};
const proofOf = (over: Record<string, unknown> = {}) => ({
  schema: 'companyos:trusted-budget-proof:1', scope: 'PRODUCTION_VERIFIED', identity,
  pricing: { source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', version: '2026-10-25', currency: 'CNY',
    units: 'MICROS_PER_MILLION_TOKENS', rounding: 'CEIL_TOTAL_PER_REQUEST_MICROS', inputRate: 2_000_000, outputRate: 8_000_000 },
  tokens: { inputUpperBound: 24_000, outputUpperBound: 2_000, evidenceRef: 'max_tokens-enforced-by-admission' },
  validFromMs: NOW - 1000, validUntilMs: NOW + 86_400_000, ...over,
});

const setup = (proof: unknown, approvalOver: Record<string, unknown> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'h10-budget-'));
  mkdirSync(join(dir, 'proofs'));
  const bytes = Buffer.from(JSON.stringify(proof));
  const hex = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, 'proofs', `${hex}.json`), bytes);
  const approval = { schema: 'companyos:budget-approval:1', approvedBy: 'user_owner', approvedAt: '2026-10-25T04:00:00Z', currency: 'CNY',
    billingScope: { providerId: 'model.deepseek', account: 'deepseek:operator', organization: null },
    cap: { maxCalls: 6, maxTokens: 160_000, maxCostMicros: 1_000_000, durationMs: 600_000 }, proofs: [`sha256:${hex}`], ...approvalOver };
  writeFileSync(join(dir, 'approvals.json'), JSON.stringify(approval));
  return { dir, ref: `sha256:${hex}`, approval };
};
const binding = { modelKey: 'm', providerId: 'model.deepseek', modelId: 'deepseek-flash' };

test('no approval file => no source (fail-closed default stands)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h10-empty-'));
  assert.equal(createDeploymentBudgetProofSource(dir, () => NOW), undefined);
  rmSync(dir, { recursive: true });
});

test('malformed approval / zero cost cap / TEST_ONLY scope are refused', () => {
  const a = setup(proofOf(), { cap: { maxCalls: 6, maxTokens: 1000, maxCostMicros: 0, durationMs: 600_000 } });
  assert.equal(createDeploymentBudgetProofSource(a.dir, () => NOW), undefined);
  const b = setup(proofOf({ scope: 'TEST_ONLY' }));
  const dep = createDeploymentBudgetProofSource(b.dir, () => NOW)!;
  return dep.source.identify(binding).then((id) => assert.equal(id, null));
});

test('approved proof gives the exact attested worst-case bound (24k in + 2k out at peak CNY rates)', async () => {
  const { dir, ref } = setup(proofOf());
  const dep = createDeploymentBudgetProofSource(dir, () => NOW)!;
  assert.deepEqual(dep.cap, { maxCalls: 6, maxTokens: 160_000, maxCostMicros: 1_000_000, durationMs: 600_000 });
  assert.notEqual(trustedBudgetPolicyId(dep.source), null);
  const bound = await trustedBudgetBound(dep.source, binding, null, NOW);
  assert.ok(bound);
  // 24000*2 + 2000*8 = 64000 micros-CNY per call (CNY 0.064)
  assert.equal(bound.costMicros, 64_000);
  assert.equal(bound.evidenceRef, ref);
  assert.equal(bound.outputTokens, 2000);
});

test('request asking more output than the proof bound is refused', async () => {
  const { dir } = setup(proofOf());
  const dep = createDeploymentBudgetProofSource(dir, () => NOW)!;
  assert.equal(await trustedBudgetBound(dep.source, binding, 8192, NOW), null);
});

test('endpoint / credential / model mismatch => no identity', async () => {
  const { dir } = setup(proofOf());
  const dep = createDeploymentBudgetProofSource(dir, () => NOW)!;
  assert.equal(await dep.source.identify({ ...binding, endpoint: 'https://evil.example' }), null);
  assert.equal(await dep.source.identify({ ...binding, credentialRef: 'vault://OTHER/live' }), null);
  assert.equal(await dep.source.identify({ ...binding, modelId: 'deepseek-v4-pro' }), null);
});

test('expired proof is not selected', async () => {
  const { dir } = setup(proofOf({ validUntilMs: NOW - 1 , validFromMs: NOW - 10 }));
  const dep = createDeploymentBudgetProofSource(dir, () => NOW)!;
  assert.equal(await trustedBudgetBound(dep.source, binding, null, NOW), null);
});

test('revocation takes effect on the next read (approval re-read every call)', async () => {
  const { dir, ref, approval } = setup(proofOf());
  const dep = createDeploymentBudgetProofSource(dir, () => NOW)!;
  assert.ok(await readTrustedBudgetProof(dep.source, ref));
  writeFileSync(join(dir, 'approvals.json'), JSON.stringify({ ...approval, proofs: ['sha256:' + '0'.repeat(64)] }));
  assert.equal(await readTrustedBudgetProof(dep.source, ref), null);
});

test('tampered proof bytes fail the digest', async () => {
  const { dir, ref } = setup(proofOf());
  const dep = createDeploymentBudgetProofSource(dir, () => NOW)!;
  writeFileSync(join(dir, 'proofs', `${ref.slice(7)}.json`), JSON.stringify(proofOf({ pricing: { ...proofOf().pricing, outputRate: 1 } })));
  assert.equal(await readTrustedBudgetProof(dep.source, ref), null);
});

test('env cannot grant trust: source ignores environment entirely', async () => {
  process.env['COMPANYOS_BUDGET_APPROVED'] = '1';
  const dir = mkdtempSync(join(tmpdir(), 'h10-env-'));
  assert.equal(createDeploymentBudgetProofSource(dir, () => NOW), undefined);
  delete process.env['COMPANYOS_BUDGET_APPROVED'];
});
