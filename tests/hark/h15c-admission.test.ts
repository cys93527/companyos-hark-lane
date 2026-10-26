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

describe.each(['installer/budget/deepseek-flash.approval-template.json', 'installer/budget/deepseek-flash.h15c.approval-template.json'])('%s', (template) => {
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
    expect(bound!.costMicros * deployment!.cap.maxCalls).toBeLessThanOrEqual(deployment!.cap.maxCostMicros);
  });
});
