#!/usr/bin/env node
// H14 — compare a vitest JSON report against the committed, triaged baseline.
// usage: node scripts/hark/compare-vitest-baseline.mjs <vitest.json> <baseline.json> [<out.json>]
// Exit 0 only when every failure (test or whole-file) is a listed, environment-bound entry.
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const failuresOf = (report, root) => {
  const out = [];
  for (const file of report.testResults ?? []) {
    const rel = relative(root, file.name).split(sep).join('/');
    const failedAssertions = (file.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of failedAssertions) {
      const name = [...(a.ancestorTitles ?? []), a.title].join(' > ');
      out.push({ id: `${rel} > ${name}`, message: String((a.failureMessages ?? [])[0] ?? '').split('\n')[0] });
    }
    if (file.status === 'failed' && failedAssertions.length === 0) {
      out.push({ id: `${rel} [file]`, message: String(file.message ?? '').split('\n')[0] });
    }
  }
  return out;
};

export const compare = (failures, baseline) => {
  const listed = new Map((baseline.entries ?? []).map((e) => [e.id, e.reason]));
  const failing = new Set(failures.map((f) => f.id));
  return {
    unexpected: failures.filter((f) => !listed.has(f.id)),
    baselined: failures.filter((f) => listed.has(f.id)).map((f) => ({ ...f, reason: listed.get(f.id) })),
    nowPassing: [...listed.keys()].filter((id) => !failing.has(id)),
  };
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [reportPath, baselinePath, outPath] = process.argv.slice(2);
  if (!reportPath || !baselinePath) {
    console.error('usage: compare-vitest-baseline.mjs <vitest.json> <baseline.json> [<out.json>]');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const failures = failuresOf(report, process.cwd());
  const result = compare(failures, baseline);
  const summary = {
    totals: { tests: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, todo: report.numTodoTests, failedFiles: report.numFailedTestSuites },
    ...result,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`tests ${summary.totals.tests} passed ${summary.totals.passed} failed ${summary.totals.failed} (failed files ${summary.totals.failedFiles})`);
  for (const b of result.baselined) console.log(`BASELINE ${b.id} — ${b.reason}`);
  for (const id of result.nowPassing) console.log(`NOW-PASSING (remove from baseline) ${id}`);
  for (const u of result.unexpected) console.log(`UNEXPECTED ${u.id} — ${u.message}`);
  process.exitCode = result.unexpected.length === 0 ? 0 : 1;
}
