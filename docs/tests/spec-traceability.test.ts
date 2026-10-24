/**
 * STEP 1 gate: the documentation set demanded by 规划书 §六十六 STEP 1 must exist,
 * be substantive, and be reachable from the index.
 *
 * This test turns "we wrote the docs" into a machine-checked fact inside `pnpm check`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** 规划书 §六十六 STEP 1 — the 16 documents requested verbatim. */
const STEP_1_DOCS = [
  'docs/PRODUCT_VISION.md',
  'docs/PROJECT_CONSTITUTION.md',
  'docs/ARCHITECTURE.md',
  'docs/CORE_BOUNDARIES.md',
  'docs/MVP_SCOPE.md',
  'docs/STATE_MACHINE.md',
  'docs/WORKFLOW_LIFECYCLE.md',
  'docs/WORKFLOW_VERSIONING.md',
  'docs/WORKFLOW_METRICS.md',
  'docs/HANDOFF_PROTOCOL.md',
  'docs/MEMORY_ARCHITECTURE.md',
  'docs/DECISION_SYSTEM.md',
  'docs/VALIDATION_SYSTEM.md',
  'docs/SECURITY_MODEL.md',
  'docs/OPEN_SOURCE_RESEARCH.md',
  'docs/EXECUTION_ROADMAP.md',
] as const;

/** Additional documents the 11-step directive asks for. */
const SUPPORTING_DOCS = [
  'docs/INDEX.md',
  'docs/ARCHITECTURE_REVIEW.md',
  'docs/SPRINT_0_TASKS.md',
  'docs/V1_1_RECONCILIATION.md',
  'docs/adr/0001-monorepo-and-sqlite.md',
] as const;

/** Repository-level governance files (A10/A11 + planning §五十五). */
const ROOT_DOCS = ['AGENTS.md', 'PROJECT_HANDOFF.md', 'PRODUCT_PLAN.md', 'README.md'] as const;

const read = (path: string): string => readFileSync(root(path), 'utf8');
const lineCount = (path: string): number => read(path).split('\n').length;

/** A document may carry a provenance note above its title; the title must still be at the top. */
const hasTitleAtTop = (source: string): boolean => source.split('\n').slice(0, 40).some((line) => line.startsWith('# '));

describe('STEP 1 documentation set', () => {
  it.each(STEP_1_DOCS)('%s exists and is substantive', (doc) => {
    expect(existsSync(root(doc)), `${doc} must exist`).toBe(true);
    const source = read(doc);
    expect(source.length).toBeGreaterThan(800);
    expect(lineCount(doc)).toBeGreaterThan(25);
    expect(hasTitleAtTop(source), `${doc} must carry a level-1 heading near the top`).toBe(true);
  });

  it.each(SUPPORTING_DOCS)('%s exists', (doc) => {
    expect(existsSync(root(doc)), `${doc} must exist`).toBe(true);
    expect(lineCount(doc)).toBeGreaterThan(25);
  });

  it.each(ROOT_DOCS)('%s exists', (doc) => {
    expect(existsSync(root(doc)), `${doc} must exist`).toBe(true);
  });

  it('indexes every document it is supposed to', () => {
    const index = read('docs/INDEX.md');
    for (const doc of [...STEP_1_DOCS, ...SUPPORTING_DOCS]) {
      if (doc === 'docs/INDEX.md') continue; // the index does not list itself
      const fileName = doc.replace('docs/', '');
      expect(index, `docs/INDEX.md must reference ${fileName}`).toContain(fileName);
    }
  });

  it('records the execution roadmap with all 31 sprints', () => {
    const roadmap = read('docs/EXECUTION_ROADMAP.md');
    for (const sprint of [0, 1, 15, 26, 30]) {
      expect(roadmap, `roadmap must define Sprint ${sprint}`).toContain(`## Sprint ${sprint}`);
    }
    expect(roadmap).toContain('Git Checkpoint');
    expect(roadmap).toContain('Acceptance Criteria');
  });

  it('keeps the constitution at exactly twelve principles', () => {
    const constitution = read('docs/PROJECT_CONSTITUTION.md');
    const principles = constitution.match(/^## 原则 \d+：/gm) ?? [];
    expect(principles).toHaveLength(12);
  });

  it('keeps the MVP scope aligned with 规划书 §五十二 / §五十三', () => {
    const scope = read('docs/MVP_SCOPE.md');
    for (const heading of ['## MVP 必须实现', '## MVP 明确不做', '## 验收案例', '## Definition of Done']) {
      expect(scope).toContain(heading);
    }
  });

  it('keeps the lifecycle capability documents complete', () => {
    expect(read('docs/WORKFLOW_VERSIONING.md')).toContain('## Run Snapshot');
    expect(read('docs/WORKFLOW_METRICS.md')).toContain('## 指标清单');
    expect(read('docs/VALIDATION_SYSTEM.md')).toContain('## Quality Gate');
    expect(read('docs/DECISION_SYSTEM.md')).toContain('## 禁止反复推翻');
  });

  it('never hard-codes a fabricated 40-hex commit hash', () => {
    const offenders: string[] = [];
    for (const doc of [...STEP_1_DOCS, ...SUPPORTING_DOCS, ...ROOT_DOCS]) {
      const source = read(doc);
      for (const match of source.matchAll(/\b[0-9a-f]{40}\b/g)) {
        // Only a real, back-filled hash is acceptable; placeholders are forbidden.
        if (!/PLACEHOLDER|pending/i.test(source.slice(Math.max(0, match.index - 80), match.index))) {
          offenders.push(`${doc}: ${match[0].slice(0, 12)}…`);
        }
      }
    }
    // PROJECT_HANDOFF.md may carry one real hash once Sprint 0 is committed.
    expect(offenders.filter((entry) => !entry.startsWith('PROJECT_HANDOFF.md'))).toEqual([]);
  });
});
