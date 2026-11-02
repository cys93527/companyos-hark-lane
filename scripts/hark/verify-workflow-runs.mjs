#!/usr/bin/env node
/**
 * AUDIT-S12 — release / live workflows may only consume an installer whose sibling gates are green.
 *
 * Pure core (unit-tested in tests/hark/audit-scripts-verify-runs.test.ts) + a CLI over JSON the workflow
 * fetched with `gh api` (this script never talks to the network itself).
 *
 *   node scripts/hark/verify-workflow-runs.mjs --mode release --sha <tag sha> --installer-run <id>
 *        --runs runs.json [--isolation-runs iso.json --isolation-shas shas.txt]
 *   node scripts/hark/verify-workflow-runs.mjs --mode installer --sha <checked-out sha> --installer-run <id> --runs run.json
 *
 * release: the given run must be hark-installer/success/head_sha==sha, and for each of hark-windows,
 * hark-ubuntu, hark-upgrade, hark-restart the LATEST completed run on that sha must be success; hark-isolation
 * (path-filtered) needs a successful run on any sha in isolation-shas (the commits from the last isolation-path
 * change up to the tag). installer: only the installer-run identity check (live workflows).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RELEASE_GATES = ['hark-windows', 'hark-ubuntu', 'hark-upgrade', 'hark-restart'];

const fail = (problems) => ({ ok: false, problems });

export const verifyInstallerRun = (run, sha, installerRunId) => {
  const problems = [];
  if (!run || typeof run !== 'object') return fail([`installer run ${installerRunId}: not found`]);
  if (String(run.id) !== String(installerRunId)) problems.push(`installer run id ${String(run.id)} != ${installerRunId}`);
  if (run.name !== 'hark-installer') problems.push(`run ${installerRunId} is ${String(run.name)}, not hark-installer`);
  if (run.status !== 'completed' || run.conclusion !== 'success') problems.push(`run ${installerRunId} is ${String(run.status)}/${String(run.conclusion)}`);
  if (run.head_sha !== sha) problems.push(`run ${installerRunId} is for ${String(run.head_sha)}, expected ${sha}`);
  return problems.length ? fail(problems) : { ok: true, problems: [] };
};

/** Latest completed run per workflow name (by run_number, then created_at). */
const latestCompleted = (runs, name, sha) => runs
  .filter((r) => r && r.name === name && r.status === 'completed' && (sha === undefined || r.head_sha === sha))
  .sort((a, b) => (Number(b.run_number) - Number(a.run_number)) || String(b.created_at).localeCompare(String(a.created_at)))[0];

export const verifyReleaseRuns = ({ runs, sha, installerRunId, isolationRuns, isolationShas }) => {
  const problems = [];
  const all = Array.isArray(runs) ? runs : [];
  const installer = all.find((r) => String(r.id) === String(installerRunId));
  problems.push(...verifyInstallerRun(installer, sha, installerRunId).problems);
  for (const name of RELEASE_GATES) {
    const latest = latestCompleted(all, name, sha);
    if (!latest) problems.push(`${name}: no completed run on ${sha}`);
    else if (latest.conclusion !== 'success') problems.push(`${name}: latest run ${String(latest.id)} on ${sha} is ${String(latest.conclusion)}`);
  }
  if (isolationShas !== undefined) {
    const shas = new Set(isolationShas);
    const iso = (Array.isArray(isolationRuns) ? isolationRuns : []).filter((r) => r && r.name === 'hark-isolation' && shas.has(r.head_sha) && r.status === 'completed');
    const latest = iso.sort((a, b) => Number(b.run_number) - Number(a.run_number))[0];
    if (!latest) problems.push('hark-isolation: no completed run since the last isolation change');
    else if (latest.conclusion !== 'success') problems.push(`hark-isolation: latest run ${String(latest.id)} is ${String(latest.conclusion)}`);
  }
  return problems.length ? fail(problems) : { ok: true, problems: [] };
};

const arg = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const runsOf = (json) => (Array.isArray(json) ? json : Array.isArray(json?.workflow_runs) ? json.workflow_runs : [json]);

export const main = (argv) => {
  const mode = arg(argv, '--mode');
  const sha = arg(argv, '--sha');
  const installerRunId = arg(argv, '--installer-run');
  const runsFile = arg(argv, '--runs');
  if (!mode || !sha || !installerRunId || !runsFile) return { code: 2, out: 'usage: --mode release|installer --sha <sha> --installer-run <id> --runs <file>' };
  const runs = runsOf(JSON.parse(readFileSync(runsFile, 'utf8')));
  let result;
  if (mode === 'installer') result = verifyInstallerRun(runs.find((r) => String(r?.id) === String(installerRunId)), sha, installerRunId);
  else if (mode === 'release') {
    const isoFile = arg(argv, '--isolation-runs');
    const shasFile = arg(argv, '--isolation-shas');
    result = verifyReleaseRuns({
      runs, sha, installerRunId,
      ...(isoFile && shasFile ? {
        isolationRuns: runsOf(JSON.parse(readFileSync(isoFile, 'utf8'))),
        isolationShas: readFileSync(shasFile, 'utf8').split(/\s+/u).filter(Boolean),
      } : {}),
    });
  } else return { code: 2, out: `unknown mode ${mode}` };
  return { code: result.ok ? 0 : 1, out: result.ok ? `verified (${mode}) ${sha}` : `REFUSED:\n${result.problems.map((p) => `  - ${p}`).join('\n')}` };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { code, out } = main(process.argv.slice(2));
  console.log(out);
  process.exit(code);
}
