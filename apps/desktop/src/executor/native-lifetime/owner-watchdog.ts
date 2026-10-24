/**
 * Hark lane — Phase 3B-3E: independent owner-hang watchdog (offline contract).
 *
 * Closes the latest named blocker: "a production owner that is still alive but
 * unresponsive has no hang-safe timeout". Kill-on-close only fires when the
 * owner process EXITS (last Job handle closes). A live-but-stuck owner keeps
 * its handle open forever and its in-process timer never runs.
 *
 * Design: the watchdog is meant to run in a SEPARATE process that holds its
 * own duplicated Job handle and a SYNCHRONIZE handle on the owner process.
 *
 *  - It trusts only lease PROGRESS (sequence numbers it observes advancing on
 *    its own monotonic clock), never timestamps written by the owner.
 *  - IMPORTANT hazard this module encodes: because the watchdog holds a Job
 *    handle, kill-on-close no longer fires when the owner dies. Therefore owner
 *    EXIT must itself be a terminate trigger, checked first on every tick.
 *  - Hard deadline is enforced independently of the owner (launch timeout plus
 *    a fixed grace), so even a heartbeating-but-runaway owner is bounded.
 *  - After terminate, success requires the Job to be drained (active 0, empty
 *    member list) within a bound; otherwise STOP_UNPROVEN. The watchdog then
 *    closes its handle, which re-arms kill-on-close for whatever remains.
 *
 * NOT delivered here (BLOCKED on the unapproved native binding / Windows host):
 * spawning the watchdog process, DuplicateHandle into it, the lease transport
 * (e.g. a named shared section or pipe) and any real Win32 call.
 */

export type WatchdogTrigger =
  | 'OWNER_EXITED'
  | 'LEASE_NEVER_STARTED'
  | 'OWNER_UNRESPONSIVE'
  | 'LEASE_REGRESSED'
  | 'HARD_DEADLINE';

export type WatchdogDecision =
  | { readonly kind: 'CONTINUE' }
  | { readonly kind: 'RELEASED' }
  | { readonly kind: 'TERMINATE'; readonly trigger: WatchdogTrigger };

export interface LeaseSnapshot {
  readonly sequence: number;
  readonly released: boolean;
}

export interface WatchdogConfig {
  /** Max silence (watchdog clock) between observed sequence advances. */
  readonly heartbeatTimeoutMs: number;
  /** Max wait for the very first beat after the watchdog arms. */
  readonly startGraceMs: number;
  /** Absolute bound from arming: launch timeout + stop grace. */
  readonly hardDeadlineMs: number;
}

export interface WatchdogState {
  readonly armedAt: number;
  readonly lastSequence: number | null;
  readonly lastProgressAt: number;
}

export function armWatchdog(now: number): WatchdogState {
  return { armedAt: now, lastSequence: null, lastProgressAt: now };
}

export function validateWatchdogConfig(config: WatchdogConfig): void {
  const ok = (v: number, max: number): boolean => Number.isSafeInteger(v) && v >= 1 && v <= max;
  if (!ok(config.heartbeatTimeoutMs, 60_000) || !ok(config.startGraceMs, 60_000) || !ok(config.hardDeadlineMs, 900_000)) {
    throw new Error('watchdog-config-refused');
  }
  if (config.heartbeatTimeoutMs >= config.hardDeadlineMs) throw new Error('watchdog-config-refused');
}

/** Pure decision step. Order matters: owner exit first, then deadline, then lease. */
export function evaluateWatchdog(
  state: WatchdogState,
  observation: { readonly ownerExited: boolean; readonly lease: LeaseSnapshot | null; readonly now: number },
  config: WatchdogConfig,
): { readonly state: WatchdogState; readonly decision: WatchdogDecision } {
  const { now, lease } = observation;
  if (observation.ownerExited) return { state, decision: { kind: 'TERMINATE', trigger: 'OWNER_EXITED' } };
  if (now - state.armedAt >= config.hardDeadlineMs) return { state, decision: { kind: 'TERMINATE', trigger: 'HARD_DEADLINE' } };
  if (lease === null || !Number.isSafeInteger(lease.sequence) || lease.sequence < 1) {
    if (state.lastSequence !== null) return { state, decision: { kind: 'TERMINATE', trigger: 'LEASE_REGRESSED' } };
    return now - state.armedAt >= config.startGraceMs
      ? { state, decision: { kind: 'TERMINATE', trigger: 'LEASE_NEVER_STARTED' } }
      : { state, decision: { kind: 'CONTINUE' } };
  }
  if (state.lastSequence !== null && lease.sequence < state.lastSequence) {
    return { state, decision: { kind: 'TERMINATE', trigger: 'LEASE_REGRESSED' } };
  }
  const advanced = state.lastSequence === null || lease.sequence > state.lastSequence;
  const next: WatchdogState = advanced ? { armedAt: state.armedAt, lastSequence: lease.sequence, lastProgressAt: now } : state;
  // A release is only honoured as a positive signal; the caller still verifies the Job is drained.
  if (lease.released) return { state: next, decision: { kind: 'RELEASED' } };
  if (now - next.lastProgressAt >= config.heartbeatTimeoutMs) {
    return { state: next, decision: { kind: 'TERMINATE', trigger: 'OWNER_UNRESPONSIVE' } };
  }
  return { state: next, decision: { kind: 'CONTINUE' } };
}

/** What the watchdog process can do with its OWN handles. */
export interface WatchdogPort {
  ownerExited(): boolean;
  readLease(): LeaseSnapshot | null;
  terminateJob(exitCode: number): void;
  jobDrained(): boolean;
  closeJobHandle(): void;
}

export interface WatchdogResult {
  readonly outcome: 'RELEASED_DRAINED' | 'TERMINATED_DRAINED' | 'STOP_UNPROVEN';
  readonly trigger: WatchdogTrigger | 'RELEASE_NOT_DRAINED' | null;
  readonly ticks: number;
  readonly errors: readonly string[];
  readonly handleClosed: boolean;
}

export const WATCHDOG_STOP_EXIT_CODE = 0xe0003e03;

export async function runOwnerWatchdog(input: {
  readonly port: WatchdogPort;
  readonly config: WatchdogConfig;
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly stopWaitMs?: number;
}): Promise<WatchdogResult> {
  validateWatchdogConfig(input.config);
  const { port, clock } = input;
  const pollMs = input.pollMs ?? 50;
  const stopWaitMs = input.stopWaitMs ?? 5_000;
  const errors: string[] = [];
  const note = (e: unknown): void => { errors.push(e instanceof Error ? e.message : String(e)); };
  let state = armWatchdog(clock());
  let ticks = 0;
  let trigger: WatchdogResult['trigger'] = null;
  let drained = false;
  let terminated = false;

  for (;;) {
    ticks += 1;
    let ownerExited: boolean;
    let lease: LeaseSnapshot | null;
    try {
      ownerExited = port.ownerExited();
      lease = port.readLease();
    } catch (e) {
      // An unreadable owner/lease is not evidence of health: fail toward stopping.
      note(e);
      ownerExited = false;
      lease = null;
      trigger = 'LEASE_REGRESSED';
    }
    const step = trigger === 'LEASE_REGRESSED'
      ? { state, decision: { kind: 'TERMINATE', trigger: 'LEASE_REGRESSED' } as WatchdogDecision }
      : evaluateWatchdog(state, { ownerExited, lease, now: clock() }, input.config);
    state = step.state;
    if (step.decision.kind === 'RELEASED') {
      let isDrained = false;
      try { isDrained = port.jobDrained(); } catch (e) { note(e); }
      if (isDrained) { drained = true; break; }
      trigger = 'RELEASE_NOT_DRAINED'; // released while members live: treat as a stop trigger
    } else if (step.decision.kind === 'TERMINATE') {
      trigger = step.decision.trigger;
    }
    if (trigger !== null) {
      terminated = true;
      try { port.terminateJob(WATCHDOG_STOP_EXIT_CODE); } catch (e) { note(e); }
      const until = clock() + stopWaitMs;
      for (;;) {
        let isDrained = false;
        try { isDrained = port.jobDrained(); } catch (e) { note(e); break; }
        if (isDrained) { drained = true; break; }
        if (clock() >= until) break;
        await input.sleep(pollMs);
      }
      break;
    }
    await input.sleep(pollMs);
  }
  let handleClosed = true;
  try { port.closeJobHandle(); } catch (e) { handleClosed = false; note(e); }
  const outcome: WatchdogResult['outcome'] = !drained || !handleClosed
    ? 'STOP_UNPROVEN'
    : terminated ? 'TERMINATED_DRAINED' : 'RELEASED_DRAINED';
  return { outcome, trigger, ticks, errors, handleClosed };
}
