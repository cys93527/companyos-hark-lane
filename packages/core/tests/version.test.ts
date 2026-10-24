/**
 * Sprint 0 acceptance: workflow versions are immutable and content-addressed, and
 * semver can only move forward (`1.3.0-draft` → `1.3.0`).
 */
import { describe, expect, it } from 'vitest';

import {
  SequenceIdFactory,
  bumpMinor,
  canonicalJson,
  createWorkflowVersion,
  draftSemverFor,
  isDraftSemver,
  isRunnableGraph,
  isSemver,
  isVersionIntact,
  parseSemver,
  recomputeContentHash,
  releaseSemver,
  type WorkflowGraph,
} from '../src/index.js';

const graph: WorkflowGraph = {
  nodes: [
    { id: 'n1', kind: 'generic.start', title: 'Start', config: {} },
    { id: 'n2', kind: 'generic.end', title: 'End', config: {} },
  ],
  edges: [{ from: 'n1', to: 'n2' }],
};

describe('workflow versions', () => {
  it('is stable across key ordering', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('mints an immutable, content-addressed version', () => {
    const version = createWorkflowVersion({
      templateId: 'tpl_1',
      semver: '1.0.0',
      graph,
      createdBy: 'user_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      ids: new SequenceIdFactory(),
    });

    expect(version.immutable).toBe(true);
    expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isVersionIntact(version)).toBe(true);

    const tampered = { ...version, graph: { ...graph, nodes: graph.nodes.slice(0, 1) } };
    expect(recomputeContentHash(tampered)).not.toBe(version.contentHash);
    expect(isVersionIntact(tampered)).toBe(false);
  });

  it('gives the same content the same hash regardless of construction order', () => {
    const ids = new SequenceIdFactory();
    const first = createWorkflowVersion({
      templateId: 'tpl_1',
      semver: '1.0.0',
      graph,
      createdBy: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      ids,
    });
    const second = createWorkflowVersion({
      templateId: 'tpl_1',
      semver: '1.0.0',
      graph,
      createdBy: 'b',
      createdAt: '2026-02-02T00:00:00.000Z',
      ids,
    });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.id).not.toBe(first.id);
  });

  it('moves semver forward only', () => {
    expect(parseSemver('1.2.3-draft')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 'draft' });
    expect(isSemver('1.2')).toBe(false);
    expect(bumpMinor('1.2.3')).toBe('1.3.0');
    expect(draftSemverFor('1.2.3')).toBe('1.3.0-draft');
    expect(isDraftSemver('1.3.0-draft')).toBe(true);
    expect(releaseSemver('1.3.0-draft')).toBe('1.3.0');
  });

  it('rejects a graph that cannot run', () => {
    expect(isRunnableGraph(graph)).toBe(true);
    expect(isRunnableGraph({ nodes: [], edges: [] })).toBe(false);
    expect(isRunnableGraph({ nodes: graph.nodes, edges: [{ from: 'n1', to: 'ghost' }] })).toBe(false);
  });
});
