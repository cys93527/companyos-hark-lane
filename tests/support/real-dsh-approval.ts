import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface RealDshApproval {
  readonly runId: string;
  readonly managedRoot: string;
  readonly workspaceRoot: string;
  readonly tempRoot: string;
  readonly evidenceRoot: string;
  readonly maxKernelStarts: number;
  readonly maxDurationMs: number;
}
// Synchronous CJS validator: the approval check precedes module-level LAB creation.
const require = createRequire(import.meta.url);
const policy = require('../../scripts/real-dsh-approval.cjs') as { requireRealDshApproval(): RealDshApproval };
export const requireRealDshApproval = (): RealDshApproval => policy.requireRealDshApproval();
export const approvalEvidencePath = (name: string): string => {
  const approval = requireRealDshApproval();
  return join(approval.evidenceRoot, `${approval.runId}-${name}.json`);
};
export const fileIdentityOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
