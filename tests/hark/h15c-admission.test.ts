/**
 * Hark lane H15c — root fix for hark-live-goal 40263437730 (GOAL_ADMISSION_REFUSED): the
 * embedded kernel's fallback route must be admitted by the operator's REAL deployment
 * approval (the same template the live workflow writes), with no test-only identity.
 *   1. one canonical credential reference for an env-held key (was `env:X` vs `vault://X/live`);
 *   2. the proof's output bound covers the deployment's declared max_tokens (8192 > 8000).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeploymentBudgetProofSource } from '../../apps/desktop/src/deployment-budget-proof.js';
import { executorFallbackBinding } from '../../apps/desktop/src/execution-safety-coordinator.js';
import { envCredentialRef } from '../../apps/desktop/src/models/credential-ref.js';
import { productionEmbeddedModelRoute } from '../../apps/desktop/src/production-composition.js';
import { trustedBudgetBound } from '../../apps/desktop/src/trusted-budget-proof.js';
// @ts-expect-error -- plain .mjs operator script, no type declarations
import { writeBudgetApproval } from '../../scripts/hark/make-budget-approval.mjs';

const ENV = {
  COS_MODEL_PROVIDER_ID: 'model.deepseek', COS_MODEL_BASE_URL: 'https://api.deepseek.com', COS_MODEL_ID: 'deepseek-flash',
  COS_MODEL_TIMEOUT_MS: '90000', COS_MODEL_STRUCTURED_OUTPUT: 'json_object', COMPANYOS_MODEL_API_KEY: 'unused-offline',
};
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

// H15c-fix10: the execute-mode workflow declares COS_MODEL_MAX_OUTPUT_TOKENS=2048 (.github/workflows/hark-live-goal.yml).
const EXECUTE_ENV = { ...ENV, COS_MODEL_MAX_OUTPUT_TOKENS: '2048' };
describe.each([
  ['installer/budget/deepseek-flash.approval-template.json', ENV],
  ['installer/budget/deepseek-flash.h15c.approval-template.json', EXECUTE_ENV],
  ['installer/budget/deepseek-flash.h15d.approval-template.json', { ...ENV, COS_MODEL_MAX_OUTPUT_TOKENS: '4096' }],
] as const)('%s', (template, ENV) => {
  it('admits the production embedded-kernel fallback route exactly as composed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h15c-budget-')); dirs.push(dir);
    writeBudgetApproval(dir, template, ENV);
    const deployment = createDeploymentBudgetProofSource(dir);
    expect(deployment).toBeDefined();
    const route = productionEmbeddedModelRoute(ENV);
    expect(route).toBeDefined();
    const binding = executorFallbackBinding(`${route!.providerId}:${route!.modelId}`, route);
    expect(binding.credentialRef).toBe(envCredentialRef('COMPANYOS_MODEL_API_KEY'));
    const bound = await trustedBudgetBound(deployment!.source, binding, route!.maxTokens ?? null, Date.now());
    expect(bound).not.toBeNull();
    expect(bound!.outputTokens).toBeGreaterThanOrEqual(route!.maxTokens!);
    expect(bound!.costMicros).toBeLessThanOrEqual(deployment!.cap.maxCostMicros);
    // H15d-fix2: the acceptance template's maxCalls is a runaway guard, not the money proof —
    // the durable authority enforces settled cost + in-flight bounds <= maxCostMicros per call.
    if (!template.includes('.h15d.')) expect(bound!.costMicros * deployment!.cap.maxCalls).toBeLessThanOrEqual(deployment!.cap.maxCostMicros);
  });
});

describe('H15c-fix10 COS_MODEL_MAX_OUTPUT_TOKENS', () => {
  it('the declared ceiling reaches the embedded kernel route; absent = 8192; out of range refused', () => {
    expect(productionEmbeddedModelRoute(EXECUTE_ENV)!.maxTokens).toBe(2048);
    expect(productionEmbeddedModelRoute(ENV)!.maxTokens).toBe(8192);
    expect(() => productionEmbeddedModelRoute({ ...ENV, COS_MODEL_MAX_OUTPUT_TOKENS: '9000' })).toThrow(/COS_MODEL_MAX_OUTPUT_TOKENS/u);
    expect(() => productionEmbeddedModelRoute({ ...ENV, COS_MODEL_MAX_OUTPUT_TOKENS: '12.5' })).toThrow(/COS_MODEL_MAX_OUTPUT_TOKENS/u);
  });
  it('a route wider than the proof bound is never admitted (8192 route vs 2048 proof)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h15c-budget-')); dirs.push(dir);
    writeBudgetApproval(dir, 'installer/budget/deepseek-flash.h15c.approval-template.json', ENV);
    const deployment = createDeploymentBudgetProofSource(dir);
    const route = productionEmbeddedModelRoute(ENV)!;
    const binding = executorFallbackBinding(`${route.providerId}:${route.modelId}`, route);
    expect(await trustedBudgetBound(deployment!.source, binding, route.maxTokens ?? null, Date.now())).toBeNull();
  });
});
