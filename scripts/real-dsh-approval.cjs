const { createHash } = require('node:crypto');
const { readFileSync, realpathSync, lstatSync } = require('node:fs');
const { resolve, dirname, parse } = require('node:path');

function requireRealDshApproval(env = process.env, now = Date.now(), { preflightOnly = false } = {}) {
  const deny = (reason) => { throw new Error(`REAL_DSH_INTEGRATION_BLOCKED: ${reason}`); };
  if (env.COMPANYOS_TEST_MODE === 'OFFLINE') deny('offline-mode-cannot-opt-in');
  const file = env.COMPANYOS_REAL_DSH_APPROVAL;
  const expected = env.COMPANYOS_REAL_DSH_APPROVAL_SHA256;
  if (!file || !/^[a-f\d]{64}$/i.test(expected ?? '')) deny('explicit-approval-and-hash-required');
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) deny('approval-hash-mismatch');
  const approval = JSON.parse(bytes.toString('utf8'));
  if (approval.authority !== 'ChatGPT Boss' || approval.mode !== 'REAL_DSH_INTEGRATION'
      || approval.windowsAclApproved !== true || approval.providerPolicy !== 'LOOPBACK_SYNTHETIC_ONLY'
      || !/^[a-zA-Z\d_-]{8,80}$/.test(approval.runId ?? '')) deny('scope-or-acl-approval-missing');
  const expiry = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 3_600_000) deny('expired-or-unbounded-approval');
  for (const field of ['workspaceRoot', 'tempRoot', 'evidenceRoot', 'managedRoot']) {
    const full = resolve(approval[field] ?? '');
    if (!/^F:[\\/]/i.test(full) || /\.companyos-embedded|DeepSeek\.gzq|Desktop-Phase3B-A-R2/i.test(full)) deny('non-disposable-root');
    if (!lstatSync(full).isDirectory() || realpathSync.native(full).toLowerCase() !== full.toLowerCase()) deny('reparse-or-missing-root');
    for (let p = full; p !== parse(p).root; p = dirname(p)) if (lstatSync(p).isSymbolicLink()) deny('reparse-parent');
    if (!full.includes(approval.runId)) deny('root-run-identity-mismatch');
    approval[field] = full;
  }
  const roots = ['workspaceRoot', 'tempRoot', 'evidenceRoot', 'managedRoot'].map(k => approval[k].toLowerCase());
  if (roots.some((a, i) => roots.some((b, j) => i !== j && (a === b || a.startsWith(b + '\\'))))) deny('overlapping-roots');
  if (!Number.isSafeInteger(approval.maxKernelStarts) || approval.maxKernelStarts < 1
      || !Number.isSafeInteger(approval.maxDurationMs) || approval.maxDurationMs < 1 || approval.maxDurationMs > 600_000) deny('bounded-run-required');
  // A future operator must supply an independently reviewed Windows preflight
  // and rollback plan. A filename or env switch alone is not that evidence.
  for (const field of ['windowsPreflight', 'aclRollbackPlan']) {
    const entry = approval[field];
    if (!entry?.path || !/^[a-f\d]{64}$/i.test(entry.sha256 ?? '')) deny('windows-preflight-or-rollback-evidence-missing');
    if (createHash('sha256').update(readFileSync(entry.path)).digest('hex') !== entry.sha256.toLowerCase()) deny('preflight-evidence-hash-mismatch');
  }
  // This repair only designs the live entry. No supervised live launcher is
  // approved/implemented here. Even a manifest cannot enable an unsupervised run.
  if (!preflightOnly) deny('bounded-live-supervisor-not-implemented');
  return approval;
}

module.exports = { requireRealDshApproval };
