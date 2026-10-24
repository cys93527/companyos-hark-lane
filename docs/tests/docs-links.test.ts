/**
 * Documentation link gate: every relative Markdown link inside the repository must
 * resolve. A dangling link is how a doc system silently rots.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// .companyos-embedded: the generated embedded agent-kernel runtime (official pinned
// upstream; gitignored) — its upstream markdown notes are not CompanyOS docs.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.pnpm-store', '.companyos-embedded']);

function markdownFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return entry.endsWith('.md') ? [full] : [];
  });
}

const LINK_PATTERN = /\]\(([^)\s]+?)(#[^)\s]*)?\)/g;

interface Link {
  readonly file: string;
  readonly target: string;
}

function collectLinks(): readonly Link[] {
  const links: Link[] = [];
  for (const file of markdownFiles(REPO_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(LINK_PATTERN)) {
      const target = match[1];
      if (target === undefined) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, …
      if (target.startsWith('#')) continue;
      links.push({ file, target: target.split('#')[0] ?? target });
    }
  }
  return links;
}

describe('markdown links', () => {
  const links = collectLinks();

  it('finds a meaningful number of links', () => {
    expect(links.length).toBeGreaterThan(20);
  });

  it('resolves every relative link', () => {
    const broken = links
      .filter((link) => !existsSync(resolve(dirname(link.file), link.target)))
      .map((link) => `${link.file.replace(REPO_ROOT, '')} -> ${link.target}`);
    expect(broken).toEqual([]);
  });

  it('keeps every document reachable from the index', () => {
    const index = readFileSync(join(REPO_ROOT, 'docs', 'INDEX.md'), 'utf8');
    const docFiles = markdownFiles(join(REPO_ROOT, 'docs'))
      .map((file) => file.replace(join(REPO_ROOT, 'docs') + '\\', '').replace(/\\/g, '/'))
      .filter((name) => name !== 'INDEX.md');
    const missing = docFiles.filter((name) => !index.includes(name));
    expect(missing).toEqual([]);
  });
});
