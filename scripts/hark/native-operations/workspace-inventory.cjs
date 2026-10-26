/*
 * CompanyOS native.job operation `workspace-inventory` (H15b). Deterministic, no network,
 * no credentials. Runs inside the kill-on-close Job Object with cwd = the trusted
 * workspace. Writes ONE real file artifact, `companyos-inventory.json`, into the
 * workspace: every regular file (relative path, bytes, sha256), sorted, bounded.
 * Prints the same JSON object on stdout (structured result for the provider).
 */
'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARTIFACT = 'companyos-inventory.json';
const MAX_FILES = 2000;
const MAX_BYTES_HASHED = 64 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.companyos']);
const root = process.cwd();
const files = [];
let hashed = 0;
let truncated = false;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (files.length >= MAX_FILES) { truncated = true; return; }
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (rel === ARTIFACT) continue;
    const size = fs.statSync(full).size;
    if (hashed + size > MAX_BYTES_HASHED) { truncated = true; files.push({ path: rel, bytes: size, sha256: null }); continue; }
    hashed += size;
    files.push({ path: rel, bytes: size, sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
  }
};
walk(root);
const inventory = { schema: 'companyos.workspace-inventory.v1', fileCount: files.length, truncated, files };
const body = JSON.stringify(inventory, null, 2) + '\n';
fs.writeFileSync(path.join(root, ARTIFACT), body, 'utf8');
process.stdout.write(JSON.stringify({ artifact: ARTIFACT, sha256: createHash('sha256').update(body).digest('hex'), fileCount: files.length, truncated }));
