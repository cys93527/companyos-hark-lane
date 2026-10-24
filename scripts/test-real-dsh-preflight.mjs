import { requireRealDshApproval } from './real-dsh-approval.mjs';

// Preflight only. It deliberately never launches Vitest, Kernel, or a shell.
try {
  const approval = requireRealDshApproval(process.env, Date.now(), {preflightOnly: true});
  console.log(JSON.stringify({ gate: 'REAL DSH INTEGRATION GATE', status: 'STATIC_APPROVAL_CONTRACT_VALID', runId: approval.runId, liveExecution: 'NOT RUN', liveGate: 'BLOCKED', next: 'Independent Windows preflight/ACL approval and a bounded supervised live runner are still required. Do not run test:kernel.' }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'REAL_DSH_INTEGRATION_BLOCKED');
  process.exitCode = 1;
}
