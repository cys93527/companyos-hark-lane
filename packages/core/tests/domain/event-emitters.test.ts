/**
 * Sprint 2 addition — the event catalog must not contain dead entries.
 *
 * Each declared event has exactly one declared emitter (`CORE_EVENT_EMITTERS`).
 * Entries whose emitter does not exist yet name the sprint that will own them, so a
 * gap is explicit instead of silent (review finding after Sprint 2).
 */
import { describe, expect, it } from 'vitest';

import {
  CORE_DOMAIN_EVENT_TYPES,
  CORE_EVENT_EMITTERS,
  emitterOf,
  isCoreDomainEventType,
  type CoreDomainEventType,
} from '@companyos/core';

const EMITTER_PATTERN = /^[a-z][a-z0-9-]*(:[A-Za-z0-9-]+)?$/;

describe('event emitter map', () => {
  it('covers the catalog exactly — no missing and no extra entry', () => {
    expect(Object.keys(CORE_EVENT_EMITTERS).sort()).toEqual([...CORE_DOMAIN_EVENT_TYPES].sort());
    expect(Object.keys(CORE_EVENT_EMITTERS)).toHaveLength(CORE_DOMAIN_EVENT_TYPES.length);
  });

  it('names a well-formed, single emitter for every event', () => {
    for (const type of CORE_DOMAIN_EVENT_TYPES) {
      const emitter = emitterOf(type);
      expect(typeof emitter, `${type} must declare an emitter`).toBe('string');
      expect(emitter.length, `${type} emitter must not be empty`).toBeGreaterThan(2);
      expect(EMITTER_PATTERN.test(emitter), `${type} emitter "${emitter}" must be well-formed`).toBe(true);
    }
  });

  it('attributes the events the engine actually emits today to the engine', () => {
    for (const type of CORE_DOMAIN_EVENT_TYPES) {
      const emittedToday =
        type.startsWith('run.') || type === 'task.state_changed' || type === 'task.blocked';
      if (emittedToday) {
        expect(emitterOf(type).startsWith('engine:'), `${type} is emitted by the engine`).toBe(true);
      }
    }
    // Creation events belong to the planner, which does not exist yet.
    for (const type of ['task.created', 'stage.created', 'stage.state_changed'] as const) {
      expect(emitterOf(type).startsWith('planner:'), `${type} awaits the planner`).toBe(true);
    }
    for (const type of ['approval.requested', 'approval.granted', 'approval.denied'] as const) {
      expect(emitterOf(type).startsWith('engine:'), `${type} is emitted with the decision`).toBe(true);
    }
  });

  it('marks the not-yet-emitted entries with their owning sprint', () => {
    const pending = CORE_DOMAIN_EVENT_TYPES.filter((type) => /S\d+$/.test(emitterOf(type)));
    expect(pending.length).toBeGreaterThan(0);
    for (const type of pending) {
      expect(emitterOf(type)).toMatch(/S\d+$/);
    }
    // The approval and task families are emitted TODAY, so they must not be pending.
    for (const type of ['approval.requested', 'approval.granted', 'approval.denied', 'task.state_changed'] as const) {
      expect(/S\d+$/.test(emitterOf(type)), `${type} must be live`).toBe(false);
    }
  });

  it('keeps the guard consistent with the map keys', () => {
    for (const type of Object.keys(CORE_EVENT_EMITTERS)) {
      expect(isCoreDomainEventType(type), `${type} must be a valid event type`).toBe(true);
    }
    const unknown: CoreDomainEventType = 'run.completed';
    expect(emitterOf(unknown)).toBe('engine:l1-machine');
  });
});
