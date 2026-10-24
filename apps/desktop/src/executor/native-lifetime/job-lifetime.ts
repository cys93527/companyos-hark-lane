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
import { LaunchPinRefused, pinLaunch, samePinnedPath, type FilePinPort, type LaunchPins } from './file-pins.js';
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
  /**
   * H5: handle-pinned launch. REQUIRED (default) means the executable, every
   * input and their directory chain are pinned (deny write/delete) and
   * re-hashed through the handle before any Job or process exists, and the
   * root's image path is checked before resume. Without a pinPort, REQUIRED
   * refuses with zero native calls.
   */
  readonly launchPinning?: 'REQUIRED' | 'NOT_ENFORCED';
  readonly pinPort?: FilePinPort;
  /**
   * H7: capture stdout/stderr through two anonymous pipes. The child inherits ONLY
   * their write ends (HANDLE_LIST); the owner closes its write ends right after
   * creation, so EOF arrives once every holder (root + descendants) has exited.
   * Bytes beyond maxBytes per stream are drained and counted, never kept.
   */
  readonly captureOutput?: { readonly maxBytes: number };
}

export interface CapturedOutput {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** Bytes produced beyond maxBytes (discarded). */
  readonly droppedBytes: { readonly stdout: number; readonly stderr: number };
  /** Both streams reached EOF (every writer closed). False = output may be partial. */
  readonly complete: boolean;
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
  /** H5: executable + inputs were held pinned from re-hash until after drain. */
  readonly launchPinned: boolean;
  /** H7: null when capture was not requested. */
  readonly output: CapturedOutput | null;
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
  /** H6: the pinning mode this adapter enforces (consumers refuse NOT_ENFORCED). */
  readonly launchPinning: 'REQUIRED' | 'NOT_ENFORCED';
  readonly outputCapture: boolean;
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

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
      launchPinned: false, output: null,
    });

    if (host.platform !== 'win32' || host.arch !== 'x64') return refuse('unsupported-host', null);
    if (!isVerifiedLaunch(launch)) return refuse('launch-not-verified', null);
    const identity = launch.identity;
    if (quarantined) return refuse('adapter-quarantined', identity);
    if (busy) return refuse('adapter-busy', identity);
    const pinning = options.launchPinning ?? 'REQUIRED';
    if (pinning === 'REQUIRED' && !options.pinPort) return refuse('launch-pinning-unavailable', identity);
    const capture = options.captureOutput ?? null;
    if (capture && (!port.createOutputPipe || !port.pipeAvailable || !port.readPipe || !port.createSuspendedInJob || assignmentPolicy !== 'ATOMIC_REQUIRED'
      || !Number.isSafeInteger(capture.maxBytes) || capture.maxBytes <= 0)) {
      return refuse('output-capture-unavailable', identity);
    }
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
    let pins: LaunchPins | null = null;
    interface Stream { read: NativeHandle | null; write: NativeHandle | null; chunks: Uint8Array[]; kept: number; dropped: number; eof: boolean }
    const streams: Stream[] = [];
    const pump = (): void => {
      if (!capture || !port.pipeAvailable || !port.readPipe) return;
      for (const st of streams) {
        if (st.eof || st.read === null) continue;
        for (let guard = 0; guard < 64; guard += 1) {
          const n = port.pipeAvailable(st.read);
          if (n < 0) { st.eof = true; break; }
          if (n === 0) break;
          const bytes = port.readPipe(st.read, Math.min(n, 1 << 20));
          if (bytes.length === 0) break;
          const room = Math.max(0, capture.maxBytes - st.kept);
          if (room > 0) { const keep = bytes.subarray(0, room); st.chunks.push(Uint8Array.from(keep)); st.kept += keep.length; }
          st.dropped += Math.max(0, bytes.length - room);
        }
      }
    };

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
      let deniedTerminate: NativeJobError | null = null;
      if (job !== null) { try { port.terminateJob(job, COMPANYOS_STOP_EXIT_CODE); jobTerminated = true; } catch (e) { fail(e); } }
      // Separately covers a legacy root that never became a member, or a failed
      // TerminateJobObject. A member root is already being reaped by the Job:
      // calling TerminateProcess on it then races its exit (native H3 run
      // 40106440529 saw ERROR_ACCESS_DENIED) and adds no proof; drain is the proof.
      // Only a NATIVELY VERIFIED member counts (a claimed/assigned one may not be).
      if (!(jobTerminated && rootMembershipVerified)) {
        try {
          if (!port.hasExited(root.process)) port.terminateProcess(root.process, COMPANYOS_STOP_EXIT_CODE);
        } catch (e) {
          // ERROR_ACCESS_DENIED (5) is what Windows returns for a process that is
          // already terminating (native run 40107390262). It is not failure by
          // itself: defer, and report it only if the root is NOT proven exited below.
          if (e instanceof NativeJobError && e.nativeCode === 5) { deniedTerminate = e; record('terminate-process-denied-awaiting-exit-proof', root.pid); } else fail(e);
        }
      }
      const settleDenied = (): void => {
        if (deniedTerminate === null) return;
        const rootEntry = entries.find(x => x.role === 'ROOT');
        if (!rootEntry || rootEntry.exitCode === null) fail(deniedTerminate);
        else record('terminate-process-denied-benign-root-exited', root?.pid);
        deniedTerminate = null;
      };
      const until = options.clock() + stopWaitMs;
      for (;;) {
        try {
          if (observe()) { settleDenied(); record('stop-drained'); return true; }
        } catch (e) { settleDenied(); fail(e); return false; }
        if (options.clock() >= until) { settleDenied(); record('stop-wait-exhausted'); return false; }
        await options.sleep(pollMs);
      }
    };
    const deadlineReached = (): boolean => options.clock() - start >= launch.timeoutMs;

    try {
      if (pinning === 'REQUIRED' && options.pinPort) {
        try {
          pins = pinLaunch(launch, options.pinPort);
        } catch (e) {
          throw e instanceof LaunchPinRefused ? new Error(`launch-pin-${e.reason.split(':')[0] ?? 'refused'}`) : e;
        }
        record('launch-pinned');
      }
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
        let stdio: { stdout: NativeHandle; stderr: NativeHandle } | undefined;
        if (capture && port.createOutputPipe) {
          for (let i = 0; i < 2; i += 1) {
            const pipe = port.createOutputPipe();
            streams.push({ read: pipe.read, write: pipe.write, chunks: [], kept: 0, dropped: 0, eof: false });
            // Read ends must never leak into the child: verify they are NOT inheritable.
            if ((port.handleFlags(pipe.read) & HANDLE_FLAG_INHERIT) !== 0) throw new Error('pipe-read-inheritable');
          }
          stdio = { stdout: streams[0]!.write!, stderr: streams[1]!.write! };
          record('output-pipes-created');
        }
        root = port.createSuspendedInJob(job, launch.executablePath, launch.commandLine, launch.cwd, env, stdio);
        handles.push(root.process, root.thread);
        // Owner write ends close now: EOF then means every child-side holder exited.
        for (const st of streams) {
          const w = st.write;
          st.write = null;
          if (w !== null) port.close(w);
        }
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
      if (pins) {
        const rootIdentity = entries.find(e => e.role === 'ROOT')?.identity;
        if (!rootIdentity || !samePinnedPath(rootIdentity.imagePath, pins.executableFinalPath)) throw new Error('image-path-mismatch');
        record('image-path-verified', root.pid);
      }
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
          pump();
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
      // Final drain: after the Job is drained every writer is gone, so EOF is reachable.
      if (capture && terminationProven) {
        for (let i = 0; i < 50 && streams.some(st => !st.eof); i += 1) {
          try { pump(); } catch (e) { fail(e); break; }
          if (streams.some(st => !st.eof)) await options.sleep(pollMs);
        }
      }
      for (const st of streams) {
        for (const h of [st.write, st.read]) {
          if (h === null) continue;
          try { port.close(h); } catch (e) { handlesClosed = false; fail(e); }
        }
        st.write = null; st.read = null;
      }
      // Job first: if anything is still alive, the last Job handle close kills it.
      for (const h of handles) {
        try { port.close(h); } catch (e) { handlesClosed = false; fail(e); }
      }
      record('handles-close-attempted');
      // Pins outlive the processes: released only after every handle (Job first) was closed.
      if (pins) {
        for (const err of pins.release()) fail(new Error(`pin-release:${err}`));
        record('pins-released');
      }
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
      accounting, errors, events, handlesClosed, quarantined, launchPinned: pins !== null,
      output: capture ? Object.freeze({
        stdout: concat(streams[0]?.chunks ?? []), stderr: concat(streams[1]?.chunks ?? []),
        droppedBytes: { stdout: streams[0]?.dropped ?? 0, stderr: streams[1]?.dropped ?? 0 },
        complete: streams.length === 2 && streams.every(st => st.eof),
      }) : null,
    };
  }

  return {
    run,
    get quarantined() { return quarantined; },
    launchPinning: options.launchPinning ?? 'REQUIRED',
    outputCapture: options.captureOutput !== undefined,
  };
}
