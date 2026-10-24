#!/usr/bin/env node
/** Remove build output, coverage and local dev database files. */
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const targets = ['dist', 'coverage', 'out', 'release', '.data', 'build'];
const patterns = [/\.tsbuildinfo$/];

let removed = 0;
for (const dir of ['packages', 'apps', '.']) {
  const base = join(ROOT, dir);
  let entries = [];
  try {
    entries = readdirSync(base);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const full = join(base, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir && targets.includes(entry)) {
      rmSync(full, { recursive: true, force: true });
      console.log(`removed ${full}`);
      removed += 1;
    }
    if (!isDir && patterns.some((p) => p.test(entry))) {
      rmSync(full, { force: true });
      console.log(`removed ${full}`);
      removed += 1;
    }
  }
}
console.log(`clean: ${removed} path(s) removed.`);
