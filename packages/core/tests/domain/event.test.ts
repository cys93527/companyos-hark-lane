/**
 * Sprint 1 Task 6: Event — the Core domain event catalog.
 *
 * Cross-check that matters: every event name the L1 machine says it emits must be
 * declared in the catalog (or be an L2 lifecycle event owned by the template
 * machine). Otherwise the audit trail would silently lose transitions.
 */
import { describe, expect, it } from 'vitest';

import {
  CORE_DOMAIN_EVENT_TYPES,
  RUN_STATES,
  SequenceIdFactory,
  allowedRunEvents,
  createCoreDomainEvent,
  eventOrderKey,
  findRunTransition,
  isCoreDomainEventType,
} from '@companyos/core';

import { nowIso } from './support.js';

/** Owned by the L2 template machine (`lifecycle/machine.ts` → TRANSITIONS[].emits). */
const L2_LIFECYCLE_EVENTS = ['workflow.template.published', 'workflow.version.created'];

describe('Core domain event catalog', () => {
  it('declares unique, well-formed event names', () => {
    expect(CORE_DOMAIN_EVENT_TYPES.length).toBeGreaterThan(40);
    expect(new Set(CORE_DOMAIN_EVENT_TYPES).size).toBe(CORE_DOMAIN_EVENT_TYPES.length);
    for (const type of CORE_DOMAIN_EVENT_TYPES) {
      expect(type, `${type} must be <aggregate>.<action>`).toMatch(/^[a-z][a-z0-9-]*\.[a-z0-9_]+$/);
    }
  });

  it('guards unknown types at runtime', () => {
    expect(isCoreDomainEventType('run.completed')).toBe(true);
    expect(isCoreDomainEventType('run.invented')).toBe(false);
    expect(isCoreDomainEventType(42)).toBe(false);
  });

  it('builds an envelope from the injected context (never the wall clock)', () => {
    const ids = new SequenceIdFactory();
    const event = createCoreDomainEvent(
      'run.completed',
      { type: 'WorkflowRun', id: 'run_1' },
      { reworkCount: 0 },
      { traceId: 'trace_1', actorId: 'user_owner', now: nowIso(5000), ids },
    );

    expect(event.type).toBe('run.completed');
    expect(event.occurredAt).toBe(nowIso(5000));
    expect(event.aggregateType).toBe('WorkflowRun');
    expect(event.aggregateId).toBe('run_1');
    expect(event.traceId).toBe('trace_1');
    expect(event.actorId).toBe('user_owner');
    expect(event.payload).toEqual({ reworkCount: 0 });
    expect(event.version).toBe(1);
    expect(event.eventId.startsWith('evt_')).toBe(true);
    expect(eventOrderKey(event)).toBe(event.eventId);
  });

  it('mints strictly increasing ids inside one millisecond', () => {
    const ids = new SequenceIdFactory();
    const context = { traceId: 't', actorId: 'a', now: nowIso(), ids };
    const first = createCoreDomainEvent('run.started', { type: 'WorkflowRun', id: 'run_1' }, {}, context);
    const second = createCoreDomainEvent('run.recovered', { type: 'WorkflowRun', id: 'run_1' }, {}, context);
    expect(second.eventId > first.eventId).toBe(true);
  });

  it('covers every event the L1 machine emits, and declares no run event it cannot emit', () => {
    const l1Emitted = new Set<string>();
    for (const state of RUN_STATES) {
      for (const event of allowedRunEvents(state)) {
        const rule = findRunTransition(event, state);
        if (rule === null) continue;
        for (const emitted of rule.emits) l1Emitted.add(emitted);
      }
    }

    // Direction 1: nothing may be emitted that is not declared somewhere.
    const declared = new Set<string>([...CORE_DOMAIN_EVENT_TYPES, ...L2_LIFECYCLE_EVENTS]);
    const undeclared = [...l1Emitted].filter((emitted) => !declared.has(emitted));
    expect(undeclared).toEqual([]);

    // Direction 2 (review finding MEDIUM-2): every declared `run.*` event must be
    // emittable by some L1 rule — no dead declarations, which would make the audit
    // trail look complete when it is not.
    const deadRunEvents = CORE_DOMAIN_EVENT_TYPES.filter(
      (type) => type.startsWith('run.') && !l1Emitted.has(type),
    );
    expect(deadRunEvents).toEqual([]);
  });
});
