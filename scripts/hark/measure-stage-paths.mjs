#!/usr/bin/env node
/**
 * Hark lane H15 — Windows MAX_PATH gate for the staged app.
 *
 * Inno Setup (and every un-prefixed Win32 call) is limited to 260 characters including
 * the NUL. hark-installer 40257828899 aborted the per-user install mid-copy because pnpm
 * virtual-store names pushed kernel paths past it. This measures the longest path below
 * the stage (relative to {app}), refuses a stage over STAGE_RELATIVE_PATH_BUDGET, and
 * prints the measured value for ISCC /DMaxRelPath (the installer refuses an install dir
 * longer than 259 - MaxRelPath - 1 up front, instead of failing half-way).
 *
 * Usage: node scripts/hark/measure-stage-paths.mjs <stage dir> [report.json]
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Leaves >= 80 characters for the install directory (default {localappdata}\Programs\CompanyOS is ~50). */
export const STAGE_RELATIVE_PATH_BUDGET = 179;

const stage = process.argv[2];
if (!stage) { console.error('usage: measure-stage-paths.mjs <stage dir> [report.json]'); process.exit(2); }
let longest = { length: 0, path: '' };
let count = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(stage, full);
    count += 1;
    if (rel.length > longest.length) longest = { length: rel.length, path: rel };
    if (entry.isDirectory()) walk(full);
  }
};
walk(stage);
const report = { stage, entries: count, maxRelativePath: longest.length, longestPath: longest.path, budget: STAGE_RELATIVE_PATH_BUDGET, installDirLimit: 259 - longest.length - 1 };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
if (longest.length > STAGE_RELATIVE_PATH_BUDGET) {
  console.error(`[measure-stage-paths] REFUSED PATH_BUDGET: ${longest.path} is ${longest.length} chars (> ${STAGE_RELATIVE_PATH_BUDGET})`);
  process.exit(1);
}
console.log(String(longest.length));
