#!/usr/bin/env node
/**
 * Hark lane H15b — native.job smoke on the STAGED app tree (byte-identical to what the
 * installer ships under <install>/resources). Windows x64 only.
 * Usage: node scripts/hark/native-job-smoke.mjs <stagedAppDir> <report.json>
 * Uses ONLY the shipped modules: productionNativeJob() from the staged
 * production-composition.js (resources resolved from its own location, no argument) and
 * composeNativeJobProvider() from the staged native-job-composition.js (verifies the
 * shipped koffi manifest, builds the Job adapter). Then runs the packaged
 * `companyos:native-inventory` operation inside a kill-on-close Job Object against a real
 * workspace and checks the real file artifact it wrote. Negative: a tampered binding
 * manifest copy is refused with zero native calls.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [stage, reportPath] = process.argv.slice(2);
if (!stage || !reportPath) { console.error('usage: native-job-smoke.mjs <stagedAppDir> <report.json>'); process.exit(2); }
const dist = join(stage, 'resources', 'app', 'apps', 'desktop', 'dist');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const report = { checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`); };
const finish = () => { writeFileSync(reportPath, JSON.stringify(report, null, 2)); process.exit(report.checks.every((c) => c.ok) ? 0 : 1); };

try {
  const pc = await import(pathToFileURL(join(dist, 'production-composition.js')).href);
  const nj = await import(pathToFileURL(join(dist, 'executor', 'native-lifetime', 'native-job-composition.js')).href);
  const job = pc.productionNativeJob();
  check('deployment-data-resolved-from-install-location', job !== undefined && job.bindingDir === join(stage, 'resources', 'native', 'koffi-3.3.3'), job?.bindingDir);
  const options = pc.productionCompositionOptions({}, {});
  check('route-native-inventory-to-native.job', options.providerRoutes?.[pc.NATIVE_INVENTORY_KIND] === nj.NATIVE_JOB_PROVIDER_KEY, options.providerRoutes?.[pc.NATIVE_INVENTORY_KIND]);

  // Negative first: a tampered copy of the binding is refused before any native call.
  const bad = mkdtempSync(join(tmpdir(), 'h15b-bad-binding-'));
  cpSync(job.bindingDir, bad, { recursive: true });
  writeFileSync(join(bad, 'node_modules', 'koffi', 'index.js'), '/* tampered */');
  const refused = nj.composeNativeJobProvider({ bindingDir: bad, operations: job.operations });
  check('tampered-binding-refused', !refused.ok && refused.reasonCode === 'NATIVE_JOB_BINDING_REFUSED', refused.ok ? 'composed!' : refused.detail);

  const composed = nj.composeNativeJobProvider({ bindingDir: job.bindingDir, operations: job.operations });
  check('provider-composed', composed.ok, composed.ok ? composed.provider.descriptor?.providerKey : composed);
  if (!composed.ok) finish();
  const provider = composed.provider;

  // Long, alias-free path (launch pinning refuses 8.3 short-name aliases such as RUNNER~1).
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'h15b-ws-')));
  mkdirSync(join(ws, 'docs'));
  writeFileSync(join(ws, 'README.md'), '# CompanyOS native.job smoke\n');
  writeFileSync(join(ws, 'docs', 'plan.txt'), 'step 1\nstep 2\n');
  const t0 = Date.now();
  const outcome = await provider.start({
    companyId: 'h15b', runId: 'h15b-run', taskId: 'inventory', attemptId: 'a1', attemptNumber: 1, roleId: 'operator',
    taskKind: pc.NATIVE_INVENTORY_KIND, work: {}, workspace: { cwd: ws, root: ws },
    requiredCapabilities: ['structured-output'], dispatchKey: 'h15b-smoke', taskText: '', structured: true, timeoutMs: 120000,
  });
  report.outcome = { ...outcome, stdoutText: outcome.stdoutText?.slice(0, 2000), stderrText: outcome.stderrText?.slice(0, 2000) };
  report.elapsedMs = Date.now() - t0;
  check('job-outcome-succeeded', outcome.kind === 'succeeded', outcome.kind === 'succeeded' ? undefined : outcome);
  const artifact = join(ws, 'companyos-inventory.json');
  check('real-file-artifact-written', existsSync(artifact), artifact);
  if (existsSync(artifact)) {
    const body = readFileSync(artifact);
    const inv = JSON.parse(body.toString('utf8'));
    // The provider contract wraps the operation's stdout object: { schema: 'companyos/native-result/1', value }.
    check('structured-result-schema', outcome.structured?.schema === 'companyos/native-result/1', outcome.structured?.schema);
    const structured = outcome.structured?.value;
    check('artifact-sha256-matches-structured-result', structured?.sha256 === sha(body), { artifact: sha(body), structured: structured?.sha256 });
    const readme = inv.files.find((f) => f.path === 'README.md');
    const plan = inv.files.find((f) => f.path === 'docs/plan.txt');
    check('inventory-content-is-real', inv.fileCount === 2 && readme?.sha256 === sha(readFileSync(join(ws, 'README.md'))) && plan?.sha256 === sha(readFileSync(join(ws, 'docs', 'plan.txt'))), inv);
    report.artifact = { path: artifact, sha256: sha(body), bytes: body.length };
  }
  check('provider-not-blocked', provider.blocked === false, provider.blockReason);
} catch (e) {
  check('smoke-threw', false, String(e?.stack ?? e));
}
finish();
