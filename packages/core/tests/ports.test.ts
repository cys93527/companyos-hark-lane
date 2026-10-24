/**
 * Sprint 0 acceptance (T0.4/T0.5): the Core package loads and exports exactly the
 * contracts the rest of the system programs against.
 */
import { describe, expect, it } from 'vitest';

import * as core from '../src/index.js';

const PORT_EXPORTS = [
  // types are erased at runtime; these are the runtime-visible port artefacts
  'SystemClock',
  'FixedClock',
  'SequenceIdFactory',
  'UlidFactory',
  'MemoryLogger',
  'nullLogger',
  'ID_PREFIX',
  'InMemoryEventBus',
] as const;

const DOMAIN_EXPORTS = [
  'ERROR_CODES',
  'DomainError',
  'LifecycleError',
  'ok',
  'err',
  'canonicalJson',
  'contentHash',
  'LIFECYCLE_STATES',
  'TRANSITIONS',
  'nextState',
  'createWorkflowVersion',
  'createRunSnapshot',
  'createTemplateLock',
  'computeWorkflowMetrics',
  'openChangeProposal',
  'createWorkflowTemplate',
] as const;

describe('@companyos/core public surface', () => {
  it.each(PORT_EXPORTS)('exposes %s', (name) => {
    expect(core[name]).toBeDefined();
  });

  it.each(DOMAIN_EXPORTS)('exposes %s', (name) => {
    expect(core[name]).toBeDefined();
  });

  it('declares the canonical id prefixes', () => {
    expect(core.ID_PREFIX.template).toBe('tpl');
    expect(core.ID_PREFIX.version).toBe('ver');
    expect(core.ID_PREFIX.run).toBe('run');
    expect(core.ID_PREFIX.snapshot).toBe('snp');
    expect(core.ID_PREFIX.lock).toBe('lck');
    expect(core.ID_PREFIX.proposal).toBe('chp');
  });

  it('freezes the lifecycle vocabulary', () => {
    expect([...core.LIFECYCLE_STATES]).toEqual(['draft', 'published', 'deprecated', 'archived']);
    expect(core.ERROR_CODES).toContain('ILLEGAL_TRANSITION');
    expect(core.ERROR_CODES).toContain('SNAPSHOT_MISMATCH');
    expect(core.ERROR_CODES).toContain('PROPOSAL_NOT_ACCEPTED');
  });
});
