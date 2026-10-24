/**
 * Sprint 5 STEP 1 — test E (graph validation): every check the Publish gate performs.
 */
import { describe, expect, it } from 'vitest';

import {
  applyChangeOps,
  assertPublishable,
  validateWorkflowGraph,
  type StageOp,
  type WorkflowGraph,
} from '@companyos/core';

const stage = (id: string, config: Record<string, unknown> = {}) => ({
  id,
  kind: 'pack-a:step',
  title: id.toUpperCase(),
  config,
});

/** A minimal publishable graph: one entry, one terminal, both reachable. */
const valid = (): WorkflowGraph => ({
  nodes: [stage('s1', { roleId: 'rol_a' }), stage('s2', { roleId: 'rol_b' })],
  edges: [{ from: 's1', to: 's2' }],
});

const codes = (graph: WorkflowGraph, options?: Parameters<typeof validateWorkflowGraph>[1]): readonly string[] =>
  validateWorkflowGraph(graph, options).issues.map((entry) => entry.code);

const build = (ops: readonly StageOp[], from: WorkflowGraph = valid()): WorkflowGraph => {
  const applied = applyChangeOps(from, ops);
  if (!applied.ok) throw new Error(`fixture failed: ${applied.error.message}`);
  return applied.value;
};

describe('E. graph validation', () => {
  it('accepts a well-formed workflow and reports entry/terminal stages', () => {
    const report = validateWorkflowGraph(valid(), { roleIds: ['rol_a', 'rol_b'] });
    expect(report).toMatchObject({ valid: true, issues: [], entryStageIds: ['s1'], terminalStageIds: ['s2'] });
  });

  it('rejects an empty workflow', () => {
    expect(codes({ nodes: [], edges: [] })).toContain('NO_STAGES');
  });

  it('rejects duplicate stage ids', () => {
    expect(codes({ nodes: [stage('s1'), stage('s1')], edges: [] })).toContain('DUPLICATE_STAGE_ID');
  });

  it('rejects a dangling edge (stage does not exist)', () => {
    expect(codes({ nodes: [stage('s1')], edges: [{ from: 's1', to: 'ghost' }] })).toContain('DANGLING_EDGE');
  });

  it('rejects a self loop', () => {
    expect(codes({ nodes: [stage('s1')], edges: [{ from: 's1', to: 's1' }] })).toContain('SELF_LOOP');
  });

  it('rejects a graph with no start stage', () => {
    const cyclic = { nodes: [stage('s1'), stage('s2')], edges: [{ from: 's1', to: 's2' }, { from: 's2', to: 's1' }] };
    const found = codes(cyclic);
    expect(found).toContain('NO_ENTRY_STAGE');
    expect(found).toContain('NO_TERMINAL_STAGE');
    expect(found).toContain('UNREACHABLE_STAGE');
  });

  it('reports stages that cannot be reached from a start stage', () => {
    const report = validateWorkflowGraph({
      nodes: [stage('s1'), stage('s2'), stage('s3'), stage('s4')],
      edges: [
        { from: 's1', to: 's2' },
        { from: 's3', to: 's4' },
        { from: 's4', to: 's3' },
      ],
    });
    // s3/s4 form their own cycle: they are entries of nothing, so nothing reaches them.
    expect(report.unreachableStageIds).toEqual(['s3', 's4']);
    expect(report.issues.map((entry) => entry.code)).toContain('UNREACHABLE_STAGE');
  });

  it('rejects a graph with no terminal path', () => {
    const loopAtEnd = { nodes: [stage('s1'), stage('s2')], edges: [{ from: 's1', to: 's2' }, { from: 's2', to: 's2' }] };
    const found = codes(loopAtEnd);
    expect(found).toContain('NO_TERMINAL_STAGE');
    expect(found).toContain('SELF_LOOP');
  });

  it('resolves role references when a catalogue is provided', () => {
    const graph = build([{ op: 'SET_ROLE', stageId: 's1', roleId: 'rol_ghost' }]);
    expect(codes(graph, { roleIds: ['rol_a', 'rol_b'] })).toContain('UNKNOWN_ROLE');
    expect(codes(graph, { roleIds: ['rol_a', 'rol_b', 'rol_ghost'] })).not.toContain('UNKNOWN_ROLE');
  });

  it('requires a role binding when the caller asks for it', () => {
    const graph = build([{ op: 'SET_ROLE', stageId: 's1', roleId: null }]);
    expect(codes(graph, { requireRole: true })).toContain('MISSING_ROLE');
    expect(codes(graph, {})).not.toContain('MISSING_ROLE');
  });

  it('resolves validator references when a catalogue is provided', () => {
    const graph = build([{ op: 'SET_VALIDATOR', stageId: 's2', validatorIds: ['val_ghost'] }]);
    expect(codes(graph, { validatorIds: ['val_schema'] })).toContain('UNKNOWN_VALIDATOR');
    expect(codes(graph, { validatorIds: ['val_ghost'] })).not.toContain('UNKNOWN_VALIDATOR');
  });

  it('rejects an unknown risk level', () => {
    const graph: WorkflowGraph = {
      nodes: [stage('s1', { riskLevel: 'CATASTROPHIC' }), stage('s2')],
      edges: [{ from: 's1', to: 's2' }],
    };
    expect(codes(graph)).toContain('INVALID_RISK');
  });

  it('rejects malformed / incomplete approval configuration', () => {
    const malformed: WorkflowGraph = {
      nodes: [stage('s1', { approval: { required: 'yes' } }), stage('s2')],
      edges: [{ from: 's1', to: 's2' }],
    };
    expect(codes(malformed)).toContain('INVALID_APPROVAL');

    const missingAuthority: WorkflowGraph = {
      nodes: [stage('s1', { approval: { required: true, mode: 'authority' } }), stage('s2')],
      edges: [{ from: 's1', to: 's2' }],
    };
    expect(codes(missingAuthority)).toContain('INVALID_APPROVAL');
  });

  it('requires an approval for HIGH and CRITICAL risk stages', () => {
    for (const riskLevel of ['HIGH', 'CRITICAL'] as const) {
      const graph = build([{ op: 'SET_RISK', stageId: 's1', riskLevel }]);
      expect(codes(graph)).toContain('INVALID_APPROVAL');

      const approved = build([
        { op: 'SET_RISK', stageId: 's1', riskLevel },
        { op: 'SET_APPROVAL', stageId: 's1', approval: { required: true, mode: 'owner' } },
      ]);
      expect(codes(approved)).not.toContain('INVALID_APPROVAL');
    }
    // LOW / MEDIUM need no approval.
    const low = build([{ op: 'SET_RISK', stageId: 's1', riskLevel: 'LOW' }]);
    expect(codes(low)).not.toContain('INVALID_APPROVAL');
  });

  it('flags every non-editable lifecycle state as read-only', () => {
    for (const state of ['published', 'deprecated', 'archived'] as const) {
      expect(codes(valid(), { lifecycleState: state })).toContain('LIFECYCLE_READONLY');
    }
    expect(codes(valid(), { lifecycleState: 'draft' })).not.toContain('LIFECYCLE_READONLY');
  });

  it('reports all problems at once instead of stopping at the first', () => {
    const graph: WorkflowGraph = {
      nodes: [stage('s1'), stage('s1'), stage('s2')],
      edges: [{ from: 's1', to: 'ghost' }],
    };
    const found = codes(graph);
    expect(found).toContain('DUPLICATE_STAGE_ID');
    expect(found).toContain('DANGLING_EDGE');
    expect(found.length).toBeGreaterThan(1);
  });
});

describe('publish gate', () => {
  it('passes a valid graph through', () => {
    const gate = assertPublishable(valid(), { roleIds: ['rol_a', 'rol_b'] });
    expect(gate.ok).toBe(true);
  });

  it('refuses an invalid graph with a VALIDATION_FAILED listing the issue codes', () => {
    const gate = assertPublishable({ nodes: [], edges: [] });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.error.code).toBe('VALIDATION_FAILED');
    expect(gate.error.details['issueCodes']).toEqual(['NO_STAGES']);
  });

  it('refuses a graph that would break the HIGH-risk approval rule', () => {
    const gate = assertPublishable(build([{ op: 'SET_RISK', stageId: 's2', riskLevel: 'CRITICAL' }]));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.error.details['issueCodes']).toContain('INVALID_APPROVAL');
  });
});
