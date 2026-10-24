/**
 * STAGE 9B-FIX — FORCED-COLLISION MECHANICAL TESTS.
 *
 * The autonomy non-determinism was a SEMANTIC decision made by ROW ORDER: the goal pipeline
 * chose the supervisor turn's subject as the first non-terminal task in `listByRun` order,
 * so two rows created in the same millisecond were arbitrated by a ULID and identical durable
 * state could yield a different legal next action. These tests FORCE every collision the
 * correction claims to survive — no sleeps, no timing dependence, no runs-until-green:
 *
 *   A. same `createdAt`, several tasks   → the semantic winner never changes with the row order;
 *   B. reversed ULID / id lexical order  → an id never picks between non-equivalent candidates;
 *   C. same corrective round timestamps → the frozen within-round rule stays a total order;
 *   D. restart row-order change         → the selection is independent of the order rows arrive;
 *   E. approval-resume re-query order   → the latest report is independent of query order.
 *
 * The frozen Sprint-20/21 stage-subject rule (corrective generation, then the earliest
 * `createdAt`, then id) is asserted verbatim — this correction changes NO selection rule; it
 * removes the ROW-ORDER path that used to bypass it.
 */
import {describe, expect, it} from 'vitest';

import {type Task} from '@companyos/core';

import {
  compareCanonicalReportOrder,
  latestCanonicalReportOf,
  stageSubjectTaskOf,
} from '@companyos/engine';

/** A minimal canonical task row — only the fields the subject rule reads. */
const task = (input: {
  readonly id: string;
  readonly createdAt: string;
  readonly state?: string;
  readonly parentTaskId?: string;
  readonly round?: number;
}): Task =>
  ({
    id: input.id,
    createdAt: input.createdAt,
    state: input.state ?? 'PENDING',
    inputs:
      input.parentTaskId === undefined
        ? {}
        : {
            corrective: {
              schemaVersion: 'companyos/corrective-task/1',
              parentTaskId: input.parentTaskId,
              round: input.round ?? 1,
            },
          },
  }) as unknown as Task;

const id = (taskRow: Task): string => String(taskRow.id);

/** Every rotation of a list, so "the order rows arrive in" is tested exhaustively. */
const rotations = <T>(items: readonly T[]): readonly (readonly T[])[] => {
  const out: (readonly T[])[] = [];
  for (let shift = 0; shift < items.length; shift += 1) {
    out.push([...items.slice(shift), ...items.slice(0, shift)]);
  }
  return out;
};

const shuffle = <T>(items: readonly T[], seed: number): readonly T[] =>
  items
    .map((item, index) => ({item, key: (index * 2654435761 + seed * 40503) % 1000003}))
    .sort((left, right) => left.key - right.key)
    .map((entry) => entry.item);

// ---------------------------------------------------------------------------
// A — the same createdAt for every task
// ---------------------------------------------------------------------------

describe('STAGE 9B-FIX D-A — several tasks created in the SAME millisecond', () => {
  const sameMillisecond = '2026-10-02T12:00:00.000Z';

  it('the selection is the latest corrective generation, whatever order the rows arrive in', () => {
    const root = task({id: 'tsk_00000000000000000000000001', createdAt: sameMillisecond, state: 'DONE'});
    const firstRound = task({id: 'tsk_ffffffffffffffffffffffffff', createdAt: sameMillisecond, parentTaskId: root.id, round: 1});
    const secondRound = task({id: 'tsk_00000000000000000000000002', createdAt: sameMillisecond, parentTaskId: firstRound.id, round: 2});
    // The lexicographically LARGEST id is the newest generation; the smallest id is the oldest.
    expect(id(stageSubjectTaskOf([root, firstRound, secondRound]) as Task)).toBe(secondRound.id);
    for (const order of rotations([root, firstRound, secondRound])) {
      expect(id(stageSubjectTaskOf(order) as Task)).toBe(secondRound.id);
    }
    for (const order of [shuffle([root, firstRound, secondRound], 1), shuffle([root, firstRound, secondRound], 7)]) {
      expect(id(stageSubjectTaskOf(order) as Task)).toBe(secondRound.id);
    }
  });

  it('the frozen within-round rule is a total order: earliest createdAt, then id', () => {
    const older = task({id: 'tsk_z', createdAt: '2026-10-02T11:00:00.000Z', state: 'DONE'});
    const newer = task({id: 'tsk_a', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'});
    // The EARLIER createdAt wins even though its id sorts later — the frozen rule, not the id.
    expect(id(stageSubjectTaskOf([older, newer]) as Task)).toBe(older.id);
    expect(id(stageSubjectTaskOf([newer, older]) as Task)).toBe(older.id);
  });
});

// ---------------------------------------------------------------------------
// B — reversed ULID / id lexical order
// ---------------------------------------------------------------------------

describe('STAGE 9B-FIX D-B — reversed ULID / id lexical order', () => {
  it('a NON-equivalent pair never changes winner when the ids swap places', () => {
    const root = task({id: 'tsk_zzz', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'});
    // The newer generation carries the lexicographically SMALLER id: the row-order race used
    // to prefer whichever of the two sorted first.
    const child = task({id: 'tsk_aaa', createdAt: '2026-10-02T12:00:00.000Z', parentTaskId: root.id, round: 1});
    expect(id(stageSubjectTaskOf([root, child]) as Task)).toBe(child.id);
    expect(id(stageSubjectTaskOf([child, root]) as Task)).toBe(child.id);

    // Swap the ids: the newer generation still wins — the id is not the decision.
    const rootSwapped = task({id: 'tsk_aaa', createdAt: root.createdAt, state: 'DONE'});
    const childSwapped = task({id: 'tsk_zzz', createdAt: child.createdAt, parentTaskId: rootSwapped.id, round: 1});
    expect(id(stageSubjectTaskOf([rootSwapped, childSwapped]) as Task)).toBe(childSwapped.id);
    expect(id(stageSubjectTaskOf([childSwapped, rootSwapped]) as Task)).toBe(childSwapped.id);
  });

  it('an EQUIVALENT pair is decided by the stable id order alone — identical either way round', () => {
    const left = task({id: 'tsk_a', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'});
    const right = task({id: 'tsk_b', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'});
    expect(id(stageSubjectTaskOf([left, right]) as Task)).toBe(left.id);
    expect(id(stageSubjectTaskOf([right, left]) as Task)).toBe(left.id);
  });
});

// ---------------------------------------------------------------------------
// C — the same corrective round, colliding timestamps
// ---------------------------------------------------------------------------

describe('STAGE 9B-FIX D-C — same corrective round, colliding timestamps', () => {
  it('the generation rule still prefers the deeper corrective round under equal clocks', () => {
    const t0 = '2026-10-02T12:00:00.000Z';
    const root = task({id: 'tsk_root', createdAt: t0, state: 'DONE'});
    const child = task({id: 'tsk_child', createdAt: t0, parentTaskId: root.id, round: 1});
    const grandchild = task({id: 'tsk_grand', createdAt: t0, parentTaskId: child.id, round: 2});
    for (const order of rotations([root, child, grandchild])) {
      expect(id(stageSubjectTaskOf(order) as Task)).toBe(grandchild.id);
    }
  });

  it('a stage with corrective children always selects INSIDE the child pool', () => {
    // An untouched sibling root is never mistaken for the live work: the children pool wins.
    const rootA = task({id: 'tsk_a', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'});
    const rootB = task({id: 'tsk_b', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'});
    const childOfA = task({id: 'tsk_c', createdAt: '2026-10-02T12:00:00.000Z', parentTaskId: rootA.id, round: 1});
    expect(id(stageSubjectTaskOf([rootA, rootB, childOfA]) as Task)).toBe(childOfA.id);
    expect(id(stageSubjectTaskOf([childOfA, rootB, rootA]) as Task)).toBe(childOfA.id);
  });
});

// ---------------------------------------------------------------------------
// D — restart row-order change
// ---------------------------------------------------------------------------

describe('STAGE 9B-FIX D-D — a restart reshuffles the order rows arrive in', () => {
  it('the subject is identical before and after a process boundary for every row order', () => {
    const rows: readonly Task[] = [
      task({id: 'tsk_impl', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'}),
      task({id: 'tsk_rev', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'}),
      task({id: 'tsk_corr', createdAt: '2026-10-02T12:00:00.001Z', parentTaskId: 'tsk_impl', round: 1, state: 'DONE'}),
    ];
    const before = id(stageSubjectTaskOf(rows) as Task);
    // The reopened store can hand the same rows back in any order; the answer may not move.
    for (const order of rotations(rows)) {
      expect(id(stageSubjectTaskOf(order) as Task)).toBe(before);
    }
    for (const seed of [2, 5, 11]) {
      expect(id(stageSubjectTaskOf(shuffle(rows, seed)) as Task)).toBe(before);
    }
    expect(before).toBe('tsk_corr');
  });

  it('an empty stage and a single-task stage are trivially stable', () => {
    expect(stageSubjectTaskOf([])).toBeNull();
    const only = task({id: 'tsk_only', createdAt: '2026-10-02T12:00:00.000Z'});
    expect(id(stageSubjectTaskOf([only]) as Task)).toBe('tsk_only');
  });
});

// ---------------------------------------------------------------------------
// E — approval-resume re-query order
// ---------------------------------------------------------------------------

describe('STAGE 9B-FIX D-E — the latest review report is independent of query order', () => {
  const candidate = (input: {
    readonly artifactId: string;
    readonly createdAt: string;
    readonly lineageRound: number;
  }) => ({artifactId: input.artifactId, createdAt: input.createdAt, lineageRound: input.lineageRound});

  it('a later CORRECTIVE GENERATION outranks an earlier one even with an older clock and a smaller id', () => {
    const roundZero = candidate({artifactId: 'art_zzz', createdAt: '2026-10-02T12:00:01.000Z', lineageRound: 0});
    const roundOne = candidate({artifactId: 'art_aaa', createdAt: '2026-10-02T12:00:00.000Z', lineageRound: 1});
    expect(latestCanonicalReportOf([roundZero, roundOne])?.artifactId).toBe('art_aaa');
    expect(latestCanonicalReportOf([roundOne, roundZero])?.artifactId).toBe('art_aaa');
  });

  it('within ONE generation the newest createdAt wins, and an id only breaks a true tie', () => {
    const older = candidate({artifactId: 'art_aaa', createdAt: '2026-10-02T12:00:00.000Z', lineageRound: 1});
    const newer = candidate({artifactId: 'art_zzz', createdAt: '2026-10-02T12:00:00.500Z', lineageRound: 1});
    expect(latestCanonicalReportOf([older, newer])?.artifactId).toBe('art_zzz');
    expect(latestCanonicalReportOf([newer, older])?.artifactId).toBe('art_zzz');

    const sameMillisecondA = candidate({artifactId: 'art_aaa', createdAt: '2026-10-02T12:00:00.000Z', lineageRound: 0});
    const sameMillisecondB = candidate({artifactId: 'art_bbb', createdAt: '2026-10-02T12:00:00.000Z', lineageRound: 0});
    for (const order of rotations([sameMillisecondA, sameMillisecondB])) {
      expect(latestCanonicalReportOf(order)?.artifactId).toBe('art_bbb');
    }
  });

  it('a re-query in any order returns the same report, and an empty set is honestly absent', () => {
    const reports = [
      ...Array.from({length: 6}, (_unused, index) =>
        candidate({artifactId: `art_x${String(index)}`, createdAt: `2026-10-02T12:00:0${String(index % 6)}.${String(index).padStart(3, '0')}Z`, lineageRound: index % 3}),
      ),
      ...Array.from({length: 4}, (_unused, index) =>
        candidate({artifactId: `art_${String(index).padStart(4, '0')}`, createdAt: '2026-10-02T12:00:00.000Z', lineageRound: index % 2}),
      ),
    ];
    const expected = latestCanonicalReportOf(reports)?.artifactId;
    expect(expected).toBeDefined();
    for (const seed of [1, 3, 9]) {
      expect(latestCanonicalReportOf(shuffle(reports, seed))?.artifactId).toBe(expected);
    }
    const reversed = latestCanonicalReportOf([...reports].reverse())?.artifactId;
    expect(reversed).toBe(expected);
    expect(latestCanonicalReportOf([])).toBeNull();
  });

  it('the comparator is antisymmetric over the semantic key', () => {
    const reports = [
      candidate({artifactId: 'art_a', createdAt: '2026-10-02T12:00:00.000Z', lineageRound: 0}),
      candidate({artifactId: 'art_b', createdAt: '2026-10-02T12:00:00.000Z', lineageRound: 1}),
      candidate({artifactId: 'art_c', createdAt: '2026-10-02T12:00:01.000Z', lineageRound: 0}),
      candidate({artifactId: 'art_d', createdAt: '2026-10-02T12:00:01.000Z', lineageRound: 1}),
    ];
    for (const left of reports) {
      for (const right of reports) {
        const forward = compareCanonicalReportOrder(left, right);
        const backward = compareCanonicalReportOrder(right, left);
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
        if (left.artifactId !== right.artifactId) expect(forward).not.toBe(0);
      }
    }
    // Generation dominates the clock: art_b (older, round 1) is later than art_c (newer, round 0).
    expect(compareCanonicalReportOrder(reports[1]!, reports[2]!)).toBeGreaterThan(0);
    // Within a generation the clock dominates the id: art_c (newer, larger id) beats art_a.
    expect(compareCanonicalReportOrder(reports[2]!, reports[0]!)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The mechanical guarantee the correction rests on
// ---------------------------------------------------------------------------

describe('STAGE 9B-FIX — row order never decides a semantic selection', () => {
  it('every permutation of a realistic corrective stage yields the same subject', () => {
    const rows: readonly Task[] = [
      task({id: 'tsk_impl', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'}),
      task({id: 'tsk_review', createdAt: '2026-10-02T12:00:00.000Z', state: 'DONE'}),
      task({id: 'tsk_fix1', createdAt: '2026-10-02T12:00:00.500Z', parentTaskId: 'tsk_impl', round: 1, state: 'DONE'}),
      task({id: 'tsk_fix2', createdAt: '2026-10-02T12:00:01.000Z', parentTaskId: 'tsk_impl', round: 2, state: 'DONE'}),
      task({id: 'tsk_review2', createdAt: '2026-10-02T12:00:01.000Z', state: 'DONE'}),
    ];
    const expected = id(stageSubjectTaskOf(rows) as Task);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(id(stageSubjectTaskOf(shuffle(rows, seed)) as Task)).toBe(expected);
    }
    expect(expected).toBe('tsk_fix2');
  });
});
