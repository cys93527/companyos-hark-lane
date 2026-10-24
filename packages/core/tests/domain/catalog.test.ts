/**
 * STEP 3A freeze: the Core Domain vocabulary is exactly 23 concepts (ADR-0002),
 * and no document may contradict that number.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CORE_CONCEPTS,
  CORE_CONCEPT_COUNT,
  CORE_CONTEXTS,
  INDUSTRY_OWNED_NOUNS,
  conceptsOwnedBy,
  coreConcept,
} from '@companyos/core';

const repo = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(repo(path), 'utf8');

/** 规划书 §四, in the order the planning document lists them. */
const FROZEN_23 = [
  'Company',
  'Industry Pack',
  'Workflow',
  'Workflow Template',
  'Workflow Version',
  'Workflow Run',
  'Stage',
  'Task',
  'Role',
  'Agent',
  'Artifact',
  'Tool',
  'Validation',
  'Approval',
  'Risk',
  'Event',
  'Memory',
  'Decision',
  'Handoff',
  'Provider',
  'Model',
  'Capability',
  'Cost',
] as const;

describe('Core Domain catalog (frozen at 23)', () => {
  it('declares exactly 23 concepts, matching 规划书 §四 verbatim', () => {
    expect(CORE_CONCEPT_COUNT).toBe(23);
    expect(CORE_CONCEPTS).toHaveLength(23);
    expect(CORE_CONCEPTS.map((concept) => concept.name)).toEqual([...FROZEN_23]);
  });

  it('has unique names and a valid owner/sprint for every concept', () => {
    const names = CORE_CONCEPTS.map((concept) => concept.name);
    expect(new Set(names).size).toBe(names.length);
    for (const concept of CORE_CONCEPTS) {
      expect(CORE_CONTEXTS).toContain(concept.owner);
      expect(concept.sprint).toMatch(/^S\d+$/);
    }
  });

  it('assigns every concept to a bounded context', () => {
    const owned = CORE_CONTEXTS.flatMap((context) => conceptsOwnedBy(context));
    expect(owned).toHaveLength(23);
  });

  it('resolves concepts by name', () => {
    expect(coreConcept('Role')?.owner).toBe('org');
    expect(coreConcept('Workflow Run')?.owner).toBe('execution');
    expect(coreConcept('NotAConcept')).toBeNull();
  });

  it('lists the eight Industry-Pack nouns Core must never know', () => {
    expect([...INDUSTRY_OWNED_NOUNS]).toEqual([
      'Coding',
      'Git',
      'Repository',
      'Developer',
      'CTO',
      'Article',
      'Video',
      'Ecommerce',
    ]);
    const names = CORE_CONCEPTS.map((concept) => concept.name);
    for (const noun of INDUSTRY_OWNED_NOUNS) {
      expect(names).not.toContain(noun);
    }
  });

  it('is not contradicted by PRODUCT_PLAN.md or AGENTS.md', () => {
    for (const doc of ['PRODUCT_PLAN.md', 'AGENTS.md']) {
      const source = read(doc);
      expect(source, `${doc} must state the frozen count`).toContain('23');
      expect(source, `${doc} must not repeat the 24 miscount`).not.toMatch(/24\s*个概念/);
      expect(source, `${doc} must not repeat the 24 miscount (en)`).not.toMatch(/24\s+concepts/i);
    }
  });

  it('keeps the freeze decisions on disk', () => {
    for (const adr of [
      'docs/adr/0002-core-domain-and-port-freeze.md',
      'docs/adr/0003-state-layering.md',
      'docs/adr/0004-single-writer-workspace.md',
      'docs/WORKSPACE_GOVERNANCE.md',
    ]) {
      const source = read(adr);
      expect(source.length).toBeGreaterThan(500);
    }
    expect(read('docs/adr/0002-core-domain-and-port-freeze.md')).toMatch(/23/);
  });
});
