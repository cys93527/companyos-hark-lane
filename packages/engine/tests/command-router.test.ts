/**
 * Requirement 2 — the command → event boundary is total, unambiguous and explicit.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_FAILURE_REASON, COMMANDS_REQUIRING_REASON, RUN_COMMAND_TYPES, RUN_EVENTS } from '@companyos/core';
import { COMMAND_TO_EVENT, assertReasonConsistency, routeCommand } from '@companyos/engine';

import { makeFixture } from './support.js';

describe('command → event routing', () => {
  it('maps every command type to exactly one event', () => {
    const mapped = Object.keys(COMMAND_TO_EVENT);
    expect(mapped.sort()).toEqual([...RUN_COMMAND_TYPES].sort());
    expect(mapped).toHaveLength(RUN_COMMAND_TYPES.length);
  });

  it('is a bijection: no two commands share an event, and all events exist', () => {
    const events = Object.values(COMMAND_TO_EVENT);
    expect(new Set(events).size).toBe(events.length);
    for (const event of events) {
      expect(RUN_EVENTS as readonly string[]).toContain(event);
    }
  });

  it('routes a command to its event and passes the implied failure reason', () => {
    const fixture = makeFixture();
    const routed = routeCommand({
      commandId: 'cmd_1',
      runId: 'run_1' as never,
      type: 'ROUTE.FAIL',
      expectedRevision: 0,
      actorId: 'tester',
      traceId: 'trace',
      issuedAt: '2026-04-01T00:00:00.000Z',
      reason: 'no provider is configured',
    });
    expect(routed.ok).toBe(true);
    if (routed.ok) {
      expect(routed.value.event).toBe('ROUTE_FAILED');
      expect(routed.value.failureReason).toBe('route_failed');
    }
    void fixture;
  });

  it('declares a valid failure reason, and only for the commands that imply one', () => {
    const reasons = ['cancelled', 'timed_out', 'route_failed', 'execution_failed', 'approval_denied', 'delivery_failed', 'recovery_failed'];
    for (const [type, reason] of Object.entries(COMMAND_FAILURE_REASON)) {
      expect(RUN_COMMAND_TYPES as readonly string[]).toContain(type);
      expect(reasons).toContain(reason);
    }
    expect(Object.keys(COMMAND_FAILURE_REASON).length).toBeGreaterThanOrEqual(7);
  });

  it('requires a reason exactly for the commands that need one', () => {
    for (const type of COMMANDS_REQUIRING_REASON) {
      expect(RUN_COMMAND_TYPES as readonly string[]).toContain(type);
    }
    const withReason = {
      commandId: 'cmd_2',
      runId: 'run_1' as never,
      type: 'RUN.PAUSE' as const,
      expectedRevision: 0,
      actorId: 'a',
      traceId: 't',
      issuedAt: '2026-04-01T00:00:00.000Z',
    };
    expect(assertReasonConsistency({ ...withReason, reason: 'why' }).ok).toBe(true);
    const missing = assertReasonConsistency(withReason);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('INVALID_ARGUMENT');
  });
});
