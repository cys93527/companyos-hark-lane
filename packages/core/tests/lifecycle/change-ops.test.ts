/**
 * Sprint 5 STEP 1 — tests C (deterministic) and D (illegal ops refused) for
 * `applyChangeOps`, plus every op in the Designer's vocabulary.
 */
import { describe, expect, it } from 'vitest';

import {
  applyChangeOp,
  applyChangeOps,
  approvalOf,
  assertEditable,
  riskLevelOf,
  roleIdOf,
  validatorIdsOf,
  type StageOp,
  type WorkflowGraph,
} from '@companyos/core';

const stage = (id: string, config: Record<string, unknown> = {}) => ({
  id,
  kind: 'pack-a:step',
  title: id.toUpperCase(),
  config,
});

const base = (): WorkflowGraph => ({
  nodes: [stage('s1'), stage('s2')],
  edges: [{ from: 's1', to: 's2' }],
});

const expectErr = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): string => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected an error');
  return result.error.code;
};

describe('C. applyChangeOps is deterministic and never mutates the input', () => {
  it('produces identical output for identical input', () => {
    const ops: readonly StageOp[] = [
      { op: 'ADD_STAGE', stage: stage('s3') },
      { op: 'CONNECT_STAGE', from: 's2', to: 's3' },
      { op: 'SET_ROLE', stageId: 's1', roleId: 'rol_a' },
    ];
    const first = applyChangeOps(base(), ops);
    const second = applyChangeOps(base(), ops);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('leaves the old graph byte-identical', () => {
    const original = base();
    const snapshot = JSON.stringify(original);
    const applied = applyChangeOps(original, [
      { op: 'SET_RISK', stageId: 's2', riskLevel: 'HIGH' },
      { op: 'REMOVE_STAGE', stageId: 's1' },
    ]);
    expect(applied.ok).toBe(true);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('returns a new object graph, not a shared reference', () => {
    const original = base();
    const applied = applyChangeOps(original, [{ op: 'SET_RISK', stageId: 's1', riskLevel: 'LOW' }]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value).not.toBe(original);
    expect(applied.value.nodes).not.toBe(original.nodes);
    expect(applied.value.nodes[0]).not.toBe(original.nodes[0]);
  });
});

describe('every stage operation in the Designer vocabulary', () => {
  it('ADD_STAGE appends a stage', () => {
    const applied = applyChangeOp(base(), { op: 'ADD_STAGE', stage: stage('s3') });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.nodes.map((node) => node.id)).toEqual(['s1', 's2', 's3']);
  });

  it('REMOVE_STAGE drops the stage AND its edges (no dangling reference)', () => {
    const applied = applyChangeOp(base(), { op: 'REMOVE_STAGE', stageId: 's2' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.nodes.map((node) => node.id)).toEqual(['s1']);
    expect(applied.value.edges).toEqual([]);
  });

  it('UPDATE_STAGE merges title / kind / config', () => {
    const applied = applyChangeOps(base(), [
      { op: 'UPDATE_STAGE', stageId: 's1', title: 'Intake', kind: 'pack-b:review' },
      { op: 'UPDATE_STAGE', stageId: 's1', config: { note: 'x' } },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const node = applied.value.nodes[0]!;
    expect(node.title).toBe('Intake');
    expect(node.kind).toBe('pack-b:review');
    expect(node.config['note']).toBe('x');
  });

  it('CONNECT_STAGE / DISCONNECT_STAGE manage edges', () => {
    const connected = applyChangeOps(base(), [
      { op: 'ADD_STAGE', stage: stage('s3') },
      { op: 'CONNECT_STAGE', from: 's2', to: 's3', condition: 'ok' },
    ]);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.edges).toHaveLength(2);

    const disconnected = applyChangeOp(connected.value, { op: 'DISCONNECT_STAGE', from: 's2', to: 's3' });
    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) return;
    expect(disconnected.value.edges).toHaveLength(1);
  });

  it('SET_ROLE / SET_VALIDATOR / SET_RISK / SET_APPROVAL write the stage config', () => {
    const applied = applyChangeOps(base(), [
      { op: 'SET_ROLE', stageId: 's1', roleId: 'rol_analyst' },
      { op: 'SET_VALIDATOR', stageId: 's1', validatorIds: ['val_schema', 'val_tone'] },
      { op: 'SET_RISK', stageId: 's1', riskLevel: 'HIGH' },
      { op: 'SET_APPROVAL', stageId: 's1', approval: { required: true, mode: 'authority', authority: 'run.approve' } },
      { op: 'SET_ROLE', stageId: 's2', roleId: null },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const [first, second] = applied.value.nodes;
    expect(roleIdOf(first!)).toBe('rol_analyst');
    expect(validatorIdsOf(first!)).toEqual(['val_schema', 'val_tone']);
    expect(riskLevelOf(first!)).toBe('HIGH');
    expect(approvalOf(first!)).toEqual({ required: true, mode: 'authority', authority: 'run.approve' });
    expect(roleIdOf(second!)).toBeNull();
  });
});

describe('D. illegal operations are refused with an explicit DomainError', () => {
  const cases: readonly { readonly name: string; readonly op: StageOp; readonly code: string }[] = [
    { name: 'duplicate stage id', op: { op: 'ADD_STAGE', stage: stage('s1') }, code: 'CONFLICT' },
    { name: 'empty stage id', op: { op: 'ADD_STAGE', stage: stage('') }, code: 'VALIDATION_FAILED' },
    { name: 'unknown stage on remove', op: { op: 'REMOVE_STAGE', stageId: 'ghost' }, code: 'NOT_FOUND' },
    {
      name: 'empty update',
      op: { op: 'UPDATE_STAGE', stageId: 's1' },
      code: 'VALIDATION_FAILED',
    },
    { name: 'unknown stage on update', op: { op: 'UPDATE_STAGE', stageId: 'ghost', title: 'x' }, code: 'NOT_FOUND' },
    { name: 'self connection', op: { op: 'CONNECT_STAGE', from: 's1', to: 's1' }, code: 'VALIDATION_FAILED' },
    { name: 'unknown endpoint', op: { op: 'CONNECT_STAGE', from: 's1', to: 'ghost' }, code: 'NOT_FOUND' },
    { name: 'duplicate edge', op: { op: 'CONNECT_STAGE', from: 's1', to: 's2' }, code: 'CONFLICT' },
    { name: 'missing edge', op: { op: 'DISCONNECT_STAGE', from: 's2', to: 's1' }, code: 'NOT_FOUND' },
    { name: 'blank role', op: { op: 'SET_ROLE', stageId: 's1', roleId: '   ' }, code: 'VALIDATION_FAILED' },
    { name: 'unknown stage on role', op: { op: 'SET_ROLE', stageId: 'ghost', roleId: 'rol_a' }, code: 'NOT_FOUND' },
    {
      name: 'blank validator id',
      op: { op: 'SET_VALIDATOR', stageId: 's1', validatorIds: [''] },
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'duplicate validator id',
      op: { op: 'SET_VALIDATOR', stageId: 's1', validatorIds: ['val_a', 'val_a'] },
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'unknown risk',
      op: { op: 'SET_RISK', stageId: 's1', riskLevel: 'CATASTROPHIC' as never },
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'unknown approval mode',
      op: { op: 'SET_APPROVAL', stageId: 's1', approval: { required: true, mode: 'maybe' as never } },
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'authority mode without authority',
      op: { op: 'SET_APPROVAL', stageId: 's1', approval: { required: true, mode: 'authority' } },
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'unknown op kind',
      op: { op: 'REWIRE_EVERYTHING' } as never,
      code: 'VALIDATION_FAILED',
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, () => {
      expect(expectErr(applyChangeOp(base(), testCase.op))).toBe(testCase.code);
    });
  }

  it('fails the whole batch at the first illegal op and returns no partial graph', () => {
    const original = base();
    const snapshot = JSON.stringify(original);
    const applied = applyChangeOps(original, [
      { op: 'ADD_STAGE', stage: stage('s3') },
      { op: 'SET_RISK', stageId: 's1', riskLevel: 'MEDIUM' },
      { op: 'REMOVE_STAGE', stageId: 'ghost' },
      { op: 'ADD_STAGE', stage: stage('s4') },
    ]);

    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('NOT_FOUND');
    expect(applied.error.details['opIndex']).toBe(2);
    expect(applied.error.details['op']).toBe('REMOVE_STAGE');
    // No partial graph anywhere: the input is untouched.
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('applies an empty batch as the identity', () => {
    const applied = applyChangeOps(base(), []);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(JSON.stringify(applied.value)).toBe(JSON.stringify(base()));
  });
});

describe('lifecycle editability guard', () => {
  it('allows draft and refuses every other lifecycle state with a precise code', () => {
    expect(assertEditable('draft').ok).toBe(true);
    expect(expectErr(assertEditable('published'))).toBe('ILLEGAL_TRANSITION');
    expect(expectErr(assertEditable('deprecated'))).toBe('DEPRECATED_TEMPLATE');
    expect(expectErr(assertEditable('archived'))).toBe('ARCHIVED_READONLY');
  });
});
