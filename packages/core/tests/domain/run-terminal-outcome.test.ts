/**
 * H12b — the typed terminal outcome over the frozen 17-state L1 machine (SM-L1-07).
 * Cancel/timeout stay FAILED + typed reason; the projection distinguishes them.
 */
import { describe, expect, it } from 'vitest';

import {
  RUN_FAILURE_REASONS,
  RUN_STATES,
  RUN_TERMINAL_OUTCOMES,
  isRunFailureReason,
  isRunTerminal,
  nextRunState,
  runTerminalOutcome,
} from '@companyos/core';

describe('runTerminalOutcome', () => {
  it('is null for every non-terminal state, whatever the reason field says', () => {
    for (const state of RUN_STATES.filter((s) => !isRunTerminal(s))) {
      expect(runTerminalOutcome({ state, failureReason: null })).toBeNull();
      expect(runTerminalOutcome({ state, failureReason: 'cancelled' })).toBeNull();
    }
  });
  it('maps COMPLETED and each FAILED reason to exactly one outcome', () => {
    expect(runTerminalOutcome({ state: 'COMPLETED', failureReason: null })).toBe('COMPLETED');
    expect(runTerminalOutcome({ state: 'FAILED', failureReason: 'cancelled' })).toBe('CANCELLED');
    expect(runTerminalOutcome({ state: 'FAILED', failureReason: 'timed_out' })).toBe('TIMED_OUT');
    for (const reason of RUN_FAILURE_REASONS.filter((r) => r !== 'cancelled' && r !== 'timed_out')) {
      expect(runTerminalOutcome({ state: 'FAILED', failureReason: reason })).toBe('FAILED');
    }
    // Never guessed as cancelled when the reason is missing.
    expect(runTerminalOutcome({ state: 'FAILED', failureReason: null })).toBe('FAILED');
    expect([...RUN_TERMINAL_OUTCOMES]).toEqual(['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'FAILED']);
  });
  it('the machine stays frozen: CANCEL still lands on FAILED (no CANCELLED run state)', () => {
    expect(RUN_STATES).toHaveLength(17);
    expect((RUN_STATES as readonly string[]).includes('CANCELLED')).toBe(false);
    const next = nextRunState('CANCEL', 'PLANNING');
    expect(next.ok && next.value).toBe('FAILED');
  });
  it('isRunFailureReason accepts only the frozen reasons', () => {
    for (const reason of RUN_FAILURE_REASONS) expect(isRunFailureReason(reason)).toBe(true);
    expect(isRunFailureReason('CANCELLED')).toBe(false);
    expect(isRunFailureReason('cancelled_by_magic')).toBe(false);
    expect(isRunFailureReason(null)).toBe(false);
  });
});
