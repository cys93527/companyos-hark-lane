#!/usr/bin/env node
// Hark lane H10: write an OPERATOR budget approval + PRODUCTION_VERIFIED price proof into a
// CompanyOS budget dir (<userData>/budget). This is the operator's own act; the app never
// writes it. Values come from the command line, never guessed:
//   node make-budget-approval.mjs <budgetDir> <approval.json-template>
// The template holds { approvedBy, attestationRef, currency, billingScope, cap, proof:{...without schema/scope} }.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Writes the approval + proof; returns what the CLI prints. Pure over (dir, template, env, now). */
export const writeBudgetApproval = (budgetDir, templatePath, env = process.env, now = Date.now()) => {
const t = JSON.parse(readFileSync(templatePath, 'utf8'));
const proof = {
  schema: 'companyos:trusted-budget-proof:1',
  scope: 'PRODUCTION_VERIFIED',
  identity: { ...t.proof.identity, endpoint: env.COS_MODEL_BASE_URL ?? t.proof.identity.endpoint, modelId: env.COS_MODEL_ID ?? t.proof.identity.modelId,
    providerId: env.COS_MODEL_PROVIDER_ID ?? t.proof.identity.providerId },
  pricing: t.proof.pricing,
  tokens: t.proof.tokens,
  validFromMs: now - 60_000,
  validUntilMs: now + t.proof.validForMs,
};
const bytes = Buffer.from(JSON.stringify(proof));
const hex = createHash('sha256').update(bytes).digest('hex');
mkdirSync(join(budgetDir, 'proofs'), { recursive: true });
writeFileSync(join(budgetDir, 'proofs', `${hex}.json`), bytes);
const approval = {
  schema: 'companyos:budget-approval:1', approvedBy: t.approvedBy, approvedAt: new Date(now).toISOString(),
  currency: t.currency, billingScope: { ...t.billingScope, providerId: proof.identity.providerId }, cap: t.cap, proofs: [`sha256:${hex}`],
};
writeFileSync(join(budgetDir, 'approvals.json'), JSON.stringify(approval, null, 2));
return { proofRef: `sha256:${hex}`, proof, approval };
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [budgetDir, templatePath] = process.argv.slice(2);
  console.log(JSON.stringify(writeBudgetApproval(budgetDir, templatePath), null, 2));
}
