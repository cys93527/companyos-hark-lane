import { describe, expect, it } from 'vitest';

import {
  allowedEvents,
  canTransition,
  findTransition,
  isState,
  isTerminal,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  nextState,
  TRANSITIONS,
  type LifecycleEvent,
  type LifecycleState,
} from '@companyos/core';

describe('lifecycle state machine (docs/STATE_MACHINE.md)', () => {
  it('declares exactly the four lifecycle states from the execution directive', () => {
    expect([...LIFECYCLE_STATES]).toEqual(['draft', 'published', 'deprecated', 'archived']);
  });

  it('declares all ten lifecycle capabilities across the transition table', () => {
    const events = new Set(TRANSITIONS.map((rule) => rule.event));
    const expected: LifecycleEvent[] = [
      'publish',
      'open_revision',
      'publish_revision',
      'fork',
      'deprecate',
      'archive',
      'lock',
      'unlock',
    ];
    for (const event of expected) expect(events.has(event)).toBe(true);
    // Draft/Publish/Version/Fork/Deprecate/Archive are states+events;
    // Run Snapshot / Template Lock / Change Proposal / Performance Metrics are
    // modelled by dedicated entities (see snapshot/lock/change-proposal/metrics tests).
    expect(LIFECYCLE_EVENTS).toHaveLength(8);
  });

  it.each([
    ['draft', 'publish', 'published'],
    ['published', 'open_revision', 'published'],
    ['published', 'publish_revision', 'published'],
    ['published', 'deprecate', 'deprecated'],
    ['deprecated', 'archive', 'archived'],
    ['published', 'lock', 'published'],
    ['published', 'unlock', 'published'],
  ] as const)('%s --%s--> %s', (from, event, to) => {
    const result = nextState(event, from);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(to);
  });

  it('refuses every illegal transition with ILLEGAL_TRANSITION and lists what is allowed', () => {
    const illegal: ReadonlyArray<[LifecycleState, LifecycleEvent]> = [
      ['draft', 'publish_revision'],
      ['draft', 'deprecate'],
      ['draft', 'archive'],
      ['draft', 'open_revision'],
      ['published', 'publish'],
      ['published', 'archive'],
      ['deprecated', 'publish'],
      ['deprecated', 'open_revision'],
      ['archived', 'publish'],
      ['archived', 'fork'],
      ['archived', 'archive'],
    ];
    for (const [from, event] of illegal) {
      const result = nextState(event, from);
      expect(result.ok, `${from} --${event}--> should be illegal`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ILLEGAL_TRANSITION');
        expect(result.error.details['allowed']).toEqual(allowedEvents(from));
      }
    }
  });

  it('treats archived as absorbing (terminal, read-only forever)', () => {
    expect(isTerminal('archived')).toBe(true);
    expect(allowedEvents('archived')).toEqual([]);
    for (const event of LIFECYCLE_EVENTS) {
      expect(canTransition(event, 'archived')).toBe(false);
    }
  });

  it('models fork as an overlay event that materialises a new template', () => {
    const rule = findTransition('fork', 'published');
    expect(rule?.to).toBe('new_template');
    expect(findTransition('fork', 'deprecated')?.to).toBe('new_template');
    const result = nextState('fork', 'published');
    expect(result.ok && result.value).toBe('published');
  });

  it('guards every rule with a non-empty guard, effect and emitted-event list', () => {
    for (const rule of TRANSITIONS) {
      expect(rule.guard.length).toBeGreaterThan(10);
      expect(rule.effect.length).toBeGreaterThan(10);
      expect(rule.emits.length).toBeGreaterThan(0);
      expect(rule.emits.every((type) => type.startsWith('workflow.'))).toBe(true);
    }
  });

  it('validates states at runtime', () => {
    expect(isState('published')).toBe(true);
    expect(isState('published ')).toBe(false);
    expect(isState(42)).toBe(false);
  });
});
