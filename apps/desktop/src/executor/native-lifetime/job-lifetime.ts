/**
 * Hark lane — Phase 3B-3E: bounded Windows Job lifetime adapter (offline).
 *
 * Lifetime ONLY. Not a sandbox (no file/network/credential isolation), not an
 * execution-permission factory, not a canonical Attempt/Budget arbiter, not a
 * Goal/Run settlement. Deliberately NOT wired into production dispatch, IPC or
 * the composition root in this phase.
 *
 * Contract (independently implemented for the Hark lane; the unaccepted source
 * candidate was only reviewed, not copied):
 *   1. Host must be win32/x64 and the launch must be a minted VerifiedLaunch.
 *   2. Job created, inherit flag cleared AND read back, kill-on-close + active
 *      process limit configured AND read back, no breakaway flag — all BEFORE
 *      any process exists, so a process never lives in an unconfigured Job.
 *   3. Default ATOMIC_REQUIRED: the root is created suspended *inside* the Job
 *      (PROC_THREAD_ATTRIBUTE_JOB_LIST). The legacy create-then-assign path is
 *      opt-in and its owner-crash orphan window is reported, never hidden.
 *   4. Membership is natively verified before the single Resume; Resume must
 *      report previous suspend count exactly 1. Any failure: never resume.
 *   5. Completion requires the Job to be drained (active 0, member list empty,
 *      every observed handle signalled). EXITED additionally requires complete
 *      identity coverage (Job total == observed members) and all codes 0.
 *      A drained Job with unobserved fast-exit members is FAILED, not EXITED.
 *   6. Cancellation / deadline observed first wins over any late zero exit.
 *   7. Uncertain stop or failed handle close => STOP_UNPROVEN and the adapter
 *      instance is quarantined; no retry, no automatic recovery here.
 *   8. Optional owner lease heartbeat for an INDEPENDENT watchdog
 *      (owner-watchdog.ts). This adapter's own timer is not hang-safe: if the
 *      owner's event loop stalls, only the watchdog can enforce the deadline.
 */
import {
  COMPANYOS_STOP_EXIT_CODE,
  HANDLE_FLAG_INHERIT,
  JOB_FORBIDDEN_FLAGS,
  JOB_REQUIRED_FLAGS,
  NativeJobError,
  type JobAccounting,
  type NativeHandle,
  type NativeProcessHandles,
  type NativeProcessIdentity,
  type WindowsJobPort,
} from './job-port.js';
import { isVerifiedLaunch, type LaunchIdentity, type VerifiedLaunch } from './launch-pins.js';

export type LifetimeOutcome = 'EXITED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'LAUNCH_FAILED' | 'STOP_UNPROVEN';
export type AssignmentMode = 'ATOMIC' | 'LEGACY_ASSIGN';

export interface OwnerLeaseWriter {
  /** Monotonically increasing sequence; the watchdog trusts only progress, never owner clocks. */
  beat(sequence: number): void;
  /** Only after proven drain and successful handle close. */
  release(): void;
}

export interface LifetimeOptions {
  readonly port: WindowsJobPort;
  /** Monotonic milliseconds. */
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly host?: { readonly platform: string; readonly arch: string };
  readonly assignment?: 'ATOMIC_REQUIRED' | 'LEGACY_ASSIGN_ALLOWED';
  readonly pollMs?: number;
  readonly stopWaitMs?: number;
  readonly activeProcessLimit?: number;
  readonly maxObservedProcesses?: number;
  readonly lease?: OwnerLeaseWriter;
  /**
   * H4: called once with the configured, verified Job handle BEFORE any process
   * exists, so an independent watchdog can be armed (it duplicates the handle).
   * If it throws, nothing is created and the run is LAUNCH_FAILED. The callee
   * must not close or retain this handle; it owns only its own duplicate.
   */
  readonly onJobReady?: (job: NativeHandle) => void;
}

export interface ObservedProcess extends NativeProcessIdentity {
  readonly role: 'ROOT' | 'DESCENDANT';
  readonly exitCode: number | null;
}

export interface LifetimeResult {
  readonly outcome: LifetimeOutcome;
  readonly identity: LaunchIdentity | null;
  readonly assignmentMode: AssignmentMode | null;
  /** True only for LEGACY_ASSIGN: an owner crash between create and assign could orphan the suspended root. */
  readonly orphanWindowExposed: boolean;
  readonly resumed: boolean;
  readonly drained: boolean;
  readonly terminationProven: boolean;
  readonly identityCoverageComplete: boolean;
  readonly rootPid: number | null;
  readonly processes: readonly ObservedProcess[];
  readonly accounting: JobAccounting | null;
  readonly errors: readonly { readonly operation: string; readonly nativeCode: number | null }[];
  readonly events: readonly { readonly name: string; readonly atMs: number; readonly pid?: number }[];
  readonly handlesClosed: boolean;
  readonly quarantined: boolean;
}

interface Entry {
  handle: NativeHandle;
  identity: NativeProcessIdentity;
  role: 'ROOT' | 'DESCENDANT';
  exitCode: number | null;
  jobMember: boolean;
}

export interface JobLifetimeAdapter {
  run(launch: VerifiedLaunch, signal?: AbortSignal): Promise<LifetimeResult>;
  readonly quarantined: boolean;
}

export function createJobLifetimeAdapter(options: LifetimeOptions): JobLifetimeAdapter {
  const port = options.port;
  const host = options.host ?? { platform: process.platform, arch: process.arch };
  const assignmentPolicy = options.assignment ?? 'ATOMIC_REQUIRED';
  const pollMs = options.pollMs ?? 10;
  const stopWaitMs = options.stopWaitMs ?? 5_000;
  const activeLimit = options.activeProcessLimit ?? 32;
  const maxObserved = options.maxObservedProcesses ?? 256;
  if (!Number.isSafeInteger(activeLimit) || activeLimit < 1 || activeLimit > 64) throw new Error('active-limit-refused');
  if (!Number.isSafeInteger(maxObserved) || maxObserved < activeLimit || maxObserved > 1024) throw new Error('observe-limit-refused');
  let busy = false;
  let quarantined = false;

  async function run(launch: VerifiedLaunch, signal?: AbortSignal): Promise<LifetimeResult> {
    const start = options.clock();
    const events: { name: string; atMs: number; pid?: number }[] = [];
    const errors: { operation: string; nativeCode: number | null }[] = [];
    const record = (name: string, pid?: number): void => {
      events.push(pid === undefined ? { name, atMs: options.clock() - start } : { name, atMs: options.clock() - start, pid });
    };
    const fail = (e: unknown): void => {
      errors.push(
        e instanceof NativeJobError
          ? { operation: e.operation, nativeCode: e.nativeCode }
          : { operation: e instanceof Error ? e.message : 'unknown', nativeCode: null },
      );
    };
    const refuse = (operation: string, identity: LaunchIdentity | null): LifetimeResult => ({
      outcome: 'LAUNCH_FAILED', identity, assignmentMode: null, orphanWindowExposed: false, resumed: false,
      drained: true, terminationProven: true, identityCoverageComplete: true, rootPid: null, processes: [],
      accounting: null, errors: [{ operation, nativeCode: null }], events, handlesClosed: true, quarantined,
    });

    if (host.platform !== 'win32' || host.arch !== 'x64') return refuse('unsupported-host', null);
    if (!isVerifiedLaunch(launch)) return refuse('launch-not-verified', null);
    const identity = launch.identity;
    if (quarantined) return refuse('adapter-quarantined', identity);
    if (busy) return refuse('adapter-busy', identity);
    if (assignmentPolicy === 'ATOMIC_REQUIRED' && typeof port.createSuspendedInJob !== 'function') {
      return refuse('atomic-job-assignment-unavailable', identity);
    }
    if (signal?.aborted) {
      record('cancel-before-create');
      return { ...refuse('cancelled-before-create', identity), outcome: 'CANCELLED', errors: [] };
    }
    busy = true;

    let job: NativeHandle | null = null;
    let root: NativeProcessHandles | null = null;
    let mode: AssignmentMode | null = null;
    let resumed = false;
    let rootMembershipVerified = false;
    let drained = false;
    let coverage = false;
    let terminationProven = false;
    let handlesClosed = true;
    let accounting: JobAccounting | null = null;
    let outcome: LifetimeOutcome = 'LAUNCH_FAILED';
    let leaseSequence = 0;
    const handles: NativeHandle[] = [];
    const entries: Entry[] = [];
    const livePid = new Map<number, Entry>();

    const beat = (): void => {
      if (!options.lease) return;
      leaseSequence += 1;
      try { options.lease.beat(leaseSequence); } catch (e) { fail(e); }
    };
    const remember = (handle: NativeHandle, pid: number, role: 'ROOT' | 'DESCENDANT', jobMember: boolean): Entry => {
      if (entries.length >= maxObserved) throw new Error('process-observation-limit');
      const entry: Entry = { handle, identity: port.identity(handle, pid), role, exitCode: null, jobMember };
      entries.push(entry);
      livePid.set(pid, entry);
      record('process-observed', pid);
      return entry;
    };
    /** One observation pass. Returns drained state; throws on any unprovable read. */
    const observe = (): boolean => {
      if (job === null) return root === null;
      const members = port.members(job);
      if (members.assigned !== members.listed.length) throw new Error('member-list-truncated');
      for (const pid of members.listed) {
        const known = livePid.get(pid);
        if (known && known.exitCode === null) continue;
        // Unknown PID, or a PID whose previous owner already exited (reuse): open fresh.
        const h = port.openProcess(pid);
        handles.push(h);
        if (!port.isInJob(job, h)) throw new Error('member-identity-mismatch');
        const id = port.identity(h, pid);
        if (known && known.identity.createdAt100ns === id.createdAt100ns) continue;
        remember(h, pid, 'DESCENDANT', true);
      }
      let allExited = true;
      for (const entry of entries) {
        if (entry.exitCode !== null) continue;
        if (port.hasExited(entry.handle)) {
          entry.exitCode = port.exitCode(entry.handle);
          record('process-exit', entry.identity.pid);
        } else {
          allExited = false;
        }
      }
      accounting = port.accounting(job);
      if (accounting.totalProcesses > maxObserved) throw new Error('process-observation-limit');
      const memberEntries = entries.filter(e => e.jobMember).length;
      coverage = accounting.totalProcesses === memberEntries;
      const after = port.members(job);
      return accounting.activeProcesses === 0 && after.assigned === 0 && after.listed.length === 0 && allExited;
    };
    const stop = async (): Promise<boolean> => {
      if (root === null) return true;
      record('stop-start');
      try { observe(); } catch (e) { fail(e); } // capture live descendants before they are reaped
      let jobTerminated = false;
      if (job !== null) { try { port.terminateJob(job, COMPANYOS_STOP_EXIT_CODE); jobTerminated = true; } catch (e) { fail(e); } }
      // Separately covers a legacy root that never became a member, or a failed
      // TerminateJobObject. A member root is already being reaped by the Job:
      // calling TerminateProcess on it then races its exit (native H3 run
      // 40106440529 saw ERROR_ACCESS_DENIED) and adds no proof; drain is the proof.
      // Only a NATIVELY VERIFIED member counts (a claimed/assigned one may not be).
      if (!(jobTerminated && rootMembershipVerified)) {
        try { if (!port.hasExited(root.process)) port.terminateProcess(root.process, COMPANYOS_STOP_EXIT_CODE); } catch (e) { fail(e); }
      }
      const until = options.clock() + stopWaitMs;
      for (;;) {
        try {
          if (observe()) { record('stop-drained'); return true; }
        } catch (e) { fail(e); return false; }
        if (options.clock() >= until) { record('stop-wait-exhausted'); return false; }
        await options.sleep(pollMs);
      }
    };
    const deadlineReached = (): boolean => options.clock() - start >= launch.timeoutMs;

    try {
      job = port.createJob();
      handles.push(job);
      record('job-created');
      port.clearInherit(job);
      if ((port.handleFlags(job) & HANDLE_FLAG_INHERIT) !== 0) throw new Error('job-handle-inheritable');
      port.configure(job, activeLimit);
      const limits = port.limits(job);
      if ((limits.flags & JOB_REQUIRED_FLAGS) !== JOB_REQUIRED_FLAGS || (limits.flags & JOB_FORBIDDEN_FLAGS) !== 0 || limits.activeProcessLimit !== activeLimit) {
        throw new Error('job-limits-unverified');
      }
      record('job-configured');
      if (options.onJobReady) {
        options.onJobReady(job);
        record('job-handed-to-watchdog');
      }
      const env = Uint8Array.from(launch.environmentBlock); // never hand the shared buffer to native code
      if (port.createSuspendedInJob && assignmentPolicy === 'ATOMIC_REQUIRED') {
        mode = 'ATOMIC';
        root = port.createSuspendedInJob(job, launch.executablePath, launch.commandLine, launch.cwd, env);
        handles.push(root.process, root.thread);
        remember(root.process, root.pid, 'ROOT', true);
      } else {
        mode = 'LEGACY_ASSIGN';
        root = port.createSuspended(launch.executablePath, launch.commandLine, launch.cwd, env);
        handles.push(root.process, root.thread);
        const rootEntry = remember(root.process, root.pid, 'ROOT', false);
        port.assign(job, root.process);
        rootEntry.jobMember = true;
      }
      record('created-suspended', root.pid);
      if (!port.isInJob(job, root.process)) throw new Error('membership-unverified');
      rootMembershipVerified = true;
      record('membership-verified', root.pid);
      beat();
      if (signal?.aborted || deadlineReached()) {
        outcome = signal?.aborted ? 'CANCELLED' : 'TIMEOUT';
        terminationProven = await stop();
        drained = terminationProven;
      } else {
        const previous = port.resume(root.thread);
        if (previous !== 1) throw new Error('unexpected-suspend-count');
        resumed = true;
        record('resumed', root.pid);
        for (;;) {
          beat();
          const reason: LifetimeOutcome | null = signal?.aborted ? 'CANCELLED' : deadlineReached() ? 'TIMEOUT' : null;
          if (reason !== null) {
            outcome = reason; // first observed stop reason wins over any late zero exit
            terminationProven = await stop();
            drained = terminationProven;
            break;
          }
          if (observe()) {
            // Re-check after the drain observation: a stop request that raced it still wins.
            if (signal?.aborted || deadlineReached()) continue;
            drained = true;
            terminationProven = true;
            const allZero = entries.every(e => e.exitCode === 0);
            outcome = coverage && allZero ? 'EXITED' : 'FAILED';
            if (!coverage) fail(new Error('unobserved-member-exit'));
            record('job-drained');
            break;
          }
          await options.sleep(pollMs);
        }
      }
    } catch (e) {
      fail(e);
      outcome = resumed ? 'FAILED' : 'LAUNCH_FAILED';
      terminationProven = await stop();
      drained = terminationProven;
    } finally {
      // Job first: if anything is still alive, the last Job handle close kills it.
      for (const h of handles) {
        try { port.close(h); } catch (e) { handlesClosed = false; fail(e); }
      }
      record('handles-close-attempted');
      if (!terminationProven || !handlesClosed) {
        outcome = 'STOP_UNPROVEN';
        quarantined = true;
      } else if (options.lease) {
        try { options.lease.release(); } catch (e) { fail(e); }
      }
      busy = false;
    }
    return {
      outcome, identity, assignmentMode: mode, orphanWindowExposed: mode === 'LEGACY_ASSIGN', resumed, drained,
      terminationProven, identityCoverageComplete: coverage, rootPid: root?.pid ?? null,
      processes: entries.map(e => Object.freeze({ ...e.identity, role: e.role, exitCode: e.exitCode })),
      accounting, errors, events, handlesClosed, quarantined,
    };
  }

  return {
    run,
    get quarantined() { return quarantined; },
  };
}
