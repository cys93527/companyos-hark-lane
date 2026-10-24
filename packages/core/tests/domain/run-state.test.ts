/**
 * STEP 3B freeze: the L1 execution machine has exactly the 17 states of
 * 规划书 §三十三, is deterministic, and never mixes in L2 template states.
 */
import { describe, expect, it } from 'vitest';

import {
  LIFECYCLE_STATES,
  PAUSABLE_RUN_STATES,
  RESUMABLE_RUN_STATES,
  RUN_EVENTS,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  allowedRunEvents,
  canRunTransition,
  findRunTransition,
  isRunState,
  isRunTerminal,
  nextRunState,
  type RunEvent,
  type RunState,
} from '@companyos/core';

import { expectErr } from './support.js';

/** The frozen 17 states, in 规划书 §三十三 order. */
const FROZEN_17 = [
  'IDLE',
  'INITIALIZING',
  'DESIGNING_WORKFLOW',
  'WORKFLOW_REVIEW',
  'WORKFLOW_PUBLISHED',
  'PLANNING',
  'ROUTING',
  'WAITING_APPROVAL',
  'EXECUTING',
  'REVIEWING',
  'VALIDATING',
  'REWORK',
  'FINALIZING',
  'COMPLETED',
  'FAILED',
  'PAUSED',
  'RECOVERING',
] as const;

describe('L1 execution machine', () => {
  it('declares exactly the 17 frozen states', () => {
    expect(RUN_STATES).toHaveLength(17);
    expect([...RUN_STATES]).toEqual([...FROZEN_17]);
  });

  it('is a different layer from the L2 template lifecycle', () => {
    // L2 states must not be L1 states (WORKFLOW_PUBLISHED is L1's own name and is
    // deliberately not the L2 `PUBLISHED`).
    const overlap = (LIFECYCLE_STATES as readonly string[]).filter((state) =>
      (RUN_STATES as readonly string[]).includes(state.toUpperCase()),
    );
    expect(overlap).toEqual([]);
    expect(RUN_STATES).not.toContain('DRAFT');
    expect(RUN_STATES).not.toContain('ARCHIVED');
  });

  it('treats only COMPLETED and FAILED as terminal (absorbing)', () => {
    expect([...RUN_TERMINAL_STATES]).toEqual(['COMPLETED', 'FAILED']);
    for (const state of RUN_STATES) {
      const outgoing = RUN_EVENTS.filter((event) => canRunTransition(event, state));
      if (isRunTerminal(state)) {
        expect(outgoing, `${state} must be absorbing`).toEqual([]);
      } else {
        expect(outgoing.length, `${state} must have at least one outgoing edge`).toBeGreaterThan(0);
      }
    }
  });

  it('walks the happy path from IDLE to COMPLETED', () => {
    const steps: ReadonlyArray<readonly [RunState, RunEvent, RunState]> = [
      ['IDLE', 'START', 'INITIALIZING'],
      ['INITIALIZING', 'TEMPLATE_RESOLVED', 'PLANNING'],
      ['PLANNING', 'PLAN_READY', 'ROUTING'],
      ['ROUTING', 'ROUTE_RESOLVED', 'EXECUTING'],
      ['EXECUTING', 'EXECUTION_DONE', 'REVIEWING'],
      ['REVIEWING', 'REVIEW_PASSED', 'VALIDATING'],
      ['VALIDATING', 'VALIDATION_PASSED', 'FINALIZING'],
      ['FINALIZING', 'DELIVERED', 'COMPLETED'],
    ];
    for (const [from, event, to] of steps) {
      const result = nextRunState(event, from);
      expect(result.ok, `${from} --${event}--> ${to}`).toBe(true);
      if (result.ok) expect(result.value).toBe(to);
    }
  });

  it('walks the SOP-design path when no template exists', () => {
    const steps: ReadonlyArray<readonly [RunState, RunEvent, RunState]> = [
      ['INITIALIZING', 'TEMPLATE_MISSING', 'DESIGNING_WORKFLOW'],
      ['DESIGNING_WORKFLOW', 'SUBMIT_DRAFT', 'WORKFLOW_REVIEW'],
      ['WORKFLOW_REVIEW', 'DRAFT_REJECTED', 'DESIGNING_WORKFLOW'],
      ['WORKFLOW_REVIEW', 'DRAFT_APPROVED', 'WORKFLOW_PUBLISHED'],
      ['WORKFLOW_PUBLISHED', 'RUN_CREATED', 'PLANNING'],
    ];
    for (const [from, event, to] of steps) {
      const result = nextRunState(event, from);
      expect(result.ok, `${from} --${event}--> ${to}`).toBe(true);
      if (result.ok) expect(result.value).toBe(to);
    }
  });

  it('models rework, approval, recovery, pause and cancellation', () => {
    expect(nextRunState('REVIEW_REJECTED', 'REVIEWING').ok && true).toBe(true);
    expect(nextRunState('VALIDATION_FAILED', 'VALIDATING').ok && true).toBe(true);
    expect(nextRunState('REWORK_READY', 'REWORK').ok && true).toBe(true);
    expect(nextRunState('REWORK_EXHAUSTED', 'REWORK').ok && true).toBe(true);
    expect(nextRunState('APPROVAL_GRANTED', 'WAITING_APPROVAL').ok && true).toBe(true);
    expect(nextRunState('APPROVAL_DENIED', 'WAITING_APPROVAL').ok && true).toBe(true);
    expect(nextRunState('CRASH_DETECTED', 'EXECUTING').ok && true).toBe(true);
    expect(nextRunState('RECOVERED', 'RECOVERING').ok && true).toBe(true);
    expect(nextRunState('RECOVERY_FAILED', 'RECOVERING').ok && true).toBe(true);
    expect(nextRunState('PAUSE', 'EXECUTING').ok && true).toBe(true);
    expect(nextRunState('RESUME', 'PAUSED').ok && true).toBe(true);

    for (const state of ['PLANNING', 'ROUTING', 'EXECUTING', 'WAITING_APPROVAL', 'REWORK'] as const) {
      const cancelled = nextRunState('CANCEL', state);
      expect(cancelled.ok, `CANCEL from ${state}`).toBe(true);
      if (cancelled.ok) expect(cancelled.value).toBe('FAILED');
    }
  });

  it('refuses illegal transitions with ILLEGAL_TRANSITION and lists what is allowed', () => {
    const illegal: ReadonlyArray<readonly [RunState, RunEvent]> = [
      ['IDLE', 'DELIVERED'],
      ['IDLE', 'TIMEOUT'],
      ['EXECUTING', 'DELIVERED'],
      ['EXECUTING', 'PLAN_READY'],
      ['PLANNING', 'REVIEW_PASSED'],
      ['COMPLETED', 'START'],
      ['FAILED', 'RESUME'],
      ['PAUSED', 'REWORK_READY'],
      ['WORKFLOW_REVIEW', 'DELIVERED'],
    ];
    for (const [from, event] of illegal) {
      const result = nextRunState(event, from);
      expect(result.ok, `${from} --${event}--> must be illegal`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ILLEGAL_TRANSITION');
        expect(result.error.details['allowed']).toEqual(allowedRunEvents(from));
      }
    }
  });

  it('exposes a queryable rule table and runtime guards', () => {
    expect(findRunTransition('START', 'IDLE')?.to).toBe('INITIALIZING');
    expect(findRunTransition('START', 'EXECUTING')).toBeNull();
    expect(allowedRunEvents('IDLE')).toEqual(['START', 'CANCEL']);
    expect(isRunState('EXECUTING')).toBe(true);
    expect(isRunState('executing')).toBe(false);
    expect(isRunState(42)).toBe(false);
    expect(expectErr(nextRunState('START', 'COMPLETED')).code).toBe('ILLEGAL_TRANSITION');
  });

  it('never lets PAUSE + RESUME shortcut planning, routing or the approval gate', () => {
    // Review finding HIGH-2: pausing is an execution-phase concept.
    expect([...PAUSABLE_RUN_STATES]).toEqual([
      'PLANNING',
      'ROUTING',
      'WAITING_APPROVAL',
      'EXECUTING',
      'REVIEWING',
      'VALIDATING',
      'REWORK',
      'FINALIZING',
    ]);
    expect([...RESUMABLE_RUN_STATES]).toEqual([...PAUSABLE_RUN_STATES]);

    for (const state of [
      'IDLE',
      'INITIALIZING',
      'DESIGNING_WORKFLOW',
      'WORKFLOW_REVIEW',
      'WORKFLOW_PUBLISHED',
    ] as const) {
      const result = nextRunState('PAUSE', state);
      expect(result.ok, `PAUSE from ${state} must be illegal`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ILLEGAL_TRANSITION');
    }
    for (const state of PAUSABLE_RUN_STATES) {
      expect(nextRunState('PAUSE', state).ok, `PAUSE from ${state}`).toBe(true);
    }
  });

  it('resumes to the recorded point, not blindly into execution', () => {
    // Without a recorded point the machine falls back to EXECUTING.
    const fallback = nextRunState('RESUME', 'PAUSED');
    expect(fallback.ok && fallback.value).toBe('EXECUTING');

    // With a recorded point, a resume returns there — so a run paused during
    // planning or approval cannot skip that gate.
    for (const point of PAUSABLE_RUN_STATES) {
      const result = nextRunState('RESUME', 'PAUSED', { resumePoint: point });
      expect(result.ok, `RESUME to ${point}`).toBe(true);
      if (result.ok) expect(result.value).toBe(point);
      const recovered = nextRunState('RECOVERED', 'RECOVERING', { resumePoint: point });
      expect(recovered.ok, `RECOVERED to ${point}`).toBe(true);
      if (recovered.ok) expect(recovered.value).toBe(point);
    }

    // An unusable point is an ERROR, never a silent jump (fail-closed, review LOW):
    // SM-L1-10 says the fallback applies only when nothing is recorded.
    const invalid = nextRunState('RESUME', 'PAUSED', { resumePoint: 'COMPLETED' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('ILLEGAL_TRANSITION');
      expect(invalid.error.details['resumePoint']).toBe('COMPLETED');
    }
    expect(nextRunState('RESUME', 'PAUSED', { resumePoint: 'IDLE' }).ok).toBe(false);
    expect(nextRunState('RECOVERED', 'RECOVERING', { resumePoint: 'PAUSED' }).ok).toBe(false);

    // …while `null`/absent still means "no recorded point" → EXECUTING.
    const explicitNull = nextRunState('RESUME', 'PAUSED', { resumePoint: null });
    expect(explicitNull.ok && explicitNull.value).toBe('EXECUTING');
  });

  it('documents every event with an effect and at least one emitted event', () => {
    const emitted = new Set<string>();
    for (const state of RUN_STATES) {
      for (const event of allowedRunEvents(state)) {
        const rule = findRunTransition(event, state);
        expect(rule, `${state} --${event}`).not.toBeNull();
        if (rule === null) continue;
        expect(rule.effect.length, `${event} needs an effect`).toBeGreaterThan(3);
        expect(rule.emits.length, `${event} must emit something`).toBeGreaterThan(0);
        for (const name of rule.emits) emitted.add(name);
      }
    }
    // Every declared event must be reachable from at least one state.
    const reachable = new Set<RunEvent>();
    for (const state of RUN_STATES) {
      for (const event of allowedRunEvents(state)) reachable.add(event);
    }
    for (const event of RUN_EVENTS) {
      expect(reachable.has(event), `${event} must be reachable from some state`).toBe(true);
    }
    expect(emitted.size).toBeGreaterThan(20);
  });
});
