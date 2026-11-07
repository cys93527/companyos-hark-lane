/**
 * LIVE-CONTRACT-FILL run 5 (hark-live-goal 42367067423): the driver finished
 * EXTERNAL_PRECONDITION_BLOCKED at 7:36 CST, the harness idled until 7:51 (IDLE_NO_PROGRESS).
 * The monitor now ends on the driver's own terminal log line.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- operator .mjs script without type declarations
import { driverEndLabel, driverEndOf } from '../../scripts/hark/live-driver-end.mjs';

type DriverEnd = { terminal: string; reason: string | null; at: string | null } | null;
const endOf = driverEndOf as (text: string, runId: string) => DriverEnd;
const RUN = 'run_01M6TW3XYAS9GPB94MP5360BCR';
const line = (terminal: string, reason: string, runId = RUN): string =>
  `{"ts":"Sat 2026-11-07 7:36 PM CST (UTC+08:00)","level":"info","msg":"autonomy driver finished","logger":"desktop","runId":"${runId}","terminal":"${terminal}","terminalReason":"${reason}","steps":1,"durationMs":614298}`;

describe('live harness ends on the autonomy driver terminal', () => {
  it('run 5: EXTERNAL_PRECONDITION_BLOCKED / GOAL_USAGE_UNKNOWN ends the monitor at once', () => {
    const end = endOf(['noise', line('EXTERNAL_PRECONDITION_BLOCKED', 'GOAL_USAGE_UNKNOWN')].join('\n'), RUN);
    expect(end).toMatchObject({ terminal: 'EXTERNAL_PRECONDITION_BLOCKED', reason: 'GOAL_USAGE_UNKNOWN' });
    expect((driverEndLabel as (e: NonNullable<DriverEnd>) => string)(end!)).toBe('DRIVER_EXTERNAL_PRECONDITION_BLOCKED:GOAL_USAGE_UNKNOWN');
  });
  it('a stall (resumed by the app) or a user decision (answered by the harness) does not end it; the newest line wins', () => {
    expect(endOf(line('AUTONOMY_STALLED', 'x'), RUN)).toBeNull();
    expect(endOf(line('USER_DECISION_REQUIRED', 'approval'), RUN)).toBeNull();
    expect(endOf([line('NON_RECOVERABLE_FAILURE', 'x'), line('AUTONOMY_STALLED', 'y')].join('\n'), RUN)).toBeNull();
    expect(endOf([line('AUTONOMY_STALLED', 'y'), line('COMPLETED', 'done')].join('\n'), RUN)?.terminal).toBe('COMPLETED');
  });
  it('another run, an unparsable line or an empty log never ends it', () => {
    expect(endOf(line('COMPLETED', 'done', 'run_other'), RUN)).toBeNull();
    expect(endOf('autonomy driver finished run_01M6TW3XYAS9GPB94MP5360BCR {broken', RUN)).toBeNull();
    expect(endOf('', RUN)).toBeNull();
  });
  it('the harness consults it in its monitor loop', () => {
    const gui = readFileSync('scripts/hark/live-goal-gui.mjs', 'utf8');
    expect(gui).toMatch(/import \{ driverEndLabel, driverEndOf \} from '\.\/live-driver-end\.mjs';/u);
    expect(gui).toMatch(/const driverEnd = driverEndOf\(appLogTail\(\), runId\);/u);
  });
});
