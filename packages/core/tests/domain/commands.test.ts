/**
 * Sprint 2 Task 1 — the command envelope contract in Core.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMANDS_REQUIRING_REASON,
  COMMAND_FAILURE_REASON,
  RUN_COMMAND_TYPES,
  commandFingerprint,
  isRunCommandType,
  validateRunCommand,
  type RunCommand,
  type RunFailureReason,
  type WorkflowRunId,
} from '@companyos/core';

const validCommand = (overrides: Partial<RunCommand> = {}): unknown => ({
  commandId: 'cmd_0001',
  runId: 'run_1' as WorkflowRunId,
  type: 'RUN.START',
  expectedRevision: 0,
  actorId: 'user_owner',
  traceId: 'trace_1',
  issuedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

describe('RunCommand contract', () => {
  it('accepts a well-formed command', () => {
    const validated = validateRunCommand(validCommand());
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.type).toBe('RUN.START');
      expect(validated.value.expectedRevision).toBe(0);
      expect(validated.value.reason).toBeUndefined();
      expect(validated.value.payload).toBeUndefined();
    }
  });

  it('accepts an optional reason and payload', () => {
    const validated = validateRunCommand(
      validCommand({ type: 'RUN.PAUSE', reason: 'stepping away', payload: { note: 'x' } }),
    );
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.reason).toBe('stepping away');
      expect(validated.value.payload).toEqual({ note: 'x' });
    }
  });

  it('rejects malformed envelopes with INVALID_ARGUMENT', () => {
    const cases: readonly [string, unknown][] = [
      ['not an object', 'RUN.START'],
      ['null', null],
      ['array', []],
      ['missing commandId', validCommand({ commandId: '' })],
      ['blank commandId', validCommand({ commandId: '   ' })],
      ['missing runId', validCommand({ runId: '' as WorkflowRunId })],
      ['unknown type', validCommand({ type: 'RUN.NOPE' as RunCommand['type'] })],
      ['negative revision', validCommand({ expectedRevision: -1 })],
      ['fractional revision', validCommand({ expectedRevision: 1.5 })],
      ['missing actor', validCommand({ actorId: '' })],
      ['missing trace', validCommand({ traceId: '' })],
      ['missing issuedAt', validCommand({ issuedAt: '' })],
      ['blank reason', validCommand({ type: 'RUN.PAUSE', reason: '  ' })],
      ['payload not an object', validCommand({ payload: 'x' as unknown as Record<string, unknown> })],
    ];
    for (const [label, value] of cases) {
      const validated = validateRunCommand(value);
      expect(validated.ok, `${label} must be rejected`).toBe(false);
      if (!validated.ok) expect(validated.error.code, label).toBe('INVALID_ARGUMENT');
    }
  });

  it('requires a reason for exactly the commands that need one', () => {
    for (const type of COMMANDS_REQUIRING_REASON) {
      const validated = validateRunCommand(validCommand({ type }));
      expect(validated.ok, `${type} without a reason must be rejected`).toBe(false);
      const withReason = validateRunCommand(validCommand({ type, reason: 'because' }));
      expect(withReason.ok, `${type} with a reason must be accepted`).toBe(true);
    }
    const withoutReasonOk = validateRunCommand(validCommand({ type: 'RUN.START' }));
    expect(withoutReasonOk.ok).toBe(true);
  });

  it('guards command types at runtime', () => {
    expect(isRunCommandType('RUN.START')).toBe(true);
    expect(isRunCommandType('run.start')).toBe(false);
    expect(isRunCommandType(42)).toBe(false);
    // LIVE-SMOKE-FIX-09: GOAL.OUTCOME.DELIVER joined the closed command set.
    expect(RUN_COMMAND_TYPES).toHaveLength(31);
  });

  it('maps implied failure reasons to real RunFailureReason values', () => {
    const reasons: readonly RunFailureReason[] = [
      'cancelled',
      'timed_out',
      'route_failed',
      'execution_failed',
      'approval_denied',
      'delivery_failed',
      'recovery_failed',
    ];
    for (const [type, reason] of Object.entries(COMMAND_FAILURE_REASON)) {
      expect(RUN_COMMAND_TYPES as readonly string[]).toContain(type);
      expect(reasons).toContain(reason);
    }
  });

  it('fingerprints the identity-relevant fields only', () => {
    const base = {
      commandId: 'cmd_1',
      runId: 'run_1' as WorkflowRunId,
      type: 'RUN.START' as const,
      expectedRevision: 0,
      actorId: 'a',
      traceId: 'trace_1',
      issuedAt: '2026-04-01T00:00:00.000Z',
    };
    // Same content, different envelope metadata (traceId/issuedAt) → same fingerprint.
    expect(commandFingerprint({ ...base, traceId: 'other' })).toBe(
      commandFingerprint({ ...base, issuedAt: '2026-05-01T00:00:00.000Z' }),
    );
    // Different intent → different fingerprint.
    expect(commandFingerprint({ ...base, type: 'RUN.CANCEL', reason: 'x' })).not.toBe(
      commandFingerprint(base),
    );
    expect(commandFingerprint({ ...base, expectedRevision: 1 })).not.toBe(commandFingerprint(base));
    expect(commandFingerprint({ ...base, actorId: 'b' })).not.toBe(commandFingerprint(base));
  });
});
