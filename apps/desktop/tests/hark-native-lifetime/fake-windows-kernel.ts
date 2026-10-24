/**
 * Deterministic OFFLINE simulation of the Win32 Job/process surface used by the
 * Hark lane lifetime adapter. SIMULATED — it proves the adapter's state logic
 * and fail-closed behaviour under injected native faults. It proves NOTHING
 * about real Windows kernel behaviour; native evidence stays NOT RUN.
 */
import { NativeJobError, type JobAccounting, type JobMemberList, type NativeHandle, type NativeProcessHandles, type WindowsJobPort } from '../../src/executor/native-lifetime/job-port.js';

export interface Script {
  /** Exit this long after the process starts running (undefined = run until killed). */
  readonly exitAfterMs?: number;
  readonly exitCode?: number;
  readonly spawn?: readonly { readonly afterMs: number; readonly script: Script; readonly image?: string }[];
  /** Models a process the kernel cannot reap (stuck in a driver): terminate is ineffective. */
  readonly unkillable?: boolean;
}

interface Proc {
  pid: number;
  created: string;
  image: string;
  state: 'suspended' | 'running' | 'exited';
  suspendCount: number;
  exitCode: number | null;
  job: number | null;
  script: Script;
  startedAt: number;
  spawned: Set<number>;
}
interface Job { id: number; flags: number; limit: number; members: Set<number>; total: number; terminated: number; openHandles: number }
interface HandleRec { kind: 'job' | 'process' | 'thread'; target: number; inherit: boolean; closed: boolean; owner: 'owner' | 'watchdog' }

export type Fault =
  | 'createJobThrows'
  | 'inheritStuck'
  | 'configureDropsKillOnClose'
  | 'configureAddsBreakaway'
  | 'createProcessThrows'
  | 'assignThrows'
  | 'assignSilentlyIgnored'
  | 'atomicCreateNotMember'
  | 'resumeReturnsZero'
  | 'resumeReturnsTwo'
  | 'membersTruncated'
  | 'membersThrowAfterResume'
  | 'openProcessThrows'
  | 'terminateJobThrows'
  | 'terminateJobIneffective'
  | 'closeThrows';

export class FakeWindowsKernel {
  now = 0;
  private nextHandle = 0x100n;
  private nextPid = 4_000;
  private nextJob = 1;
  readonly handles = new Map<NativeHandle, HandleRec>();
  readonly jobs = new Map<number, Job>();
  readonly procs = new Map<number, Proc>();
  readonly faults = new Set<Fault>();
  readonly calls: string[] = [];
  private resumed = false;
  /** Default program for any launched image. */
  rootScript: Script = { exitAfterMs: 20, exitCode: 0 };
  /** Count of processes resumed (i.e. that actually started executing code). */
  executedCount = 0;

  private issue(kind: HandleRec['kind'], target: number, owner: HandleRec['owner'] = 'owner'): NativeHandle {
    const h = this.nextHandle;
    this.nextHandle += 4n;
    this.handles.set(h, { kind, target, inherit: kind === 'job' ? false : false, closed: false, owner });
    if (kind === 'job') this.jobs.get(target)!.openHandles += 1;
    return h;
  }
  private rec(h: NativeHandle, kind?: HandleRec['kind']): HandleRec {
    const r = this.handles.get(h);
    if (!r || r.closed || (kind && r.kind !== kind)) throw new NativeJobError('invalid-handle', 6);
    return r;
  }
  private jobOf(h: NativeHandle): Job { return this.jobs.get(this.rec(h, 'job').target)!; }
  private procOf(h: NativeHandle): Proc { return this.procs.get(this.rec(h).target)!; }

  private spawnProc(image: string, script: Script, job: number | null, suspended: boolean): Proc | null {
    if (job !== null) {
      const j = this.jobs.get(job)!;
      if (j.members.size >= j.limit && (j.flags & 0x8) !== 0) return null; // ActiveProcessLimit refuses the birth
    }
    const pid = this.nextPid;
    this.nextPid += 4;
    const p: Proc = { pid, created: String(1_000_000 + this.now * 10_000 + pid), image, state: suspended ? 'suspended' : 'running', suspendCount: suspended ? 1 : 0, exitCode: null, job, script, startedAt: this.now, spawned: new Set() };
    this.procs.set(pid, p);
    if (job !== null) { const j = this.jobs.get(job)!; j.members.add(pid); j.total += 1; }
    if (!suspended) this.executedCount += 1;
    return p;
  }
  private exit(p: Proc, code: number, terminated: boolean): void {
    if (p.state === 'exited') return;
    p.state = 'exited';
    p.exitCode = code;
    if (p.job !== null) { const j = this.jobs.get(p.job)!; j.members.delete(p.pid); if (terminated) j.terminated += 1; }
  }
  private killJob(j: Job, code: number): void {
    for (const pid of [...j.members]) { const p = this.procs.get(pid)!; if (!p.script.unkillable) this.exit(p, code, true); }
  }

  /** Advance simulated time, running process scripts millisecond by millisecond. */
  advance(ms: number): void {
    for (let i = 0; i < ms; i += 1) {
      this.now += 1;
      for (const p of [...this.procs.values()]) {
        if (p.state !== 'running') continue;
        const age = this.now - p.startedAt;
        (p.script.spawn ?? []).forEach((s, index) => {
          if (age >= s.afterMs && !p.spawned.has(index)) {
            p.spawned.add(index);
            this.spawnProc(s.image ?? 'C:\\Windows\\System32\\child.exe', s.script, p.job, false);
          }
        });
        if (p.script.exitAfterMs !== undefined && age >= p.script.exitAfterMs) this.exit(p, p.script.exitCode ?? 0, false);
      }
    }
  }

  /** Owner process dies: every handle it held is closed by the kernel. */
  crashOwner(): void {
    for (const [h, r] of this.handles) if (r.owner === 'owner' && !r.closed) this.closeRec(h, r);
  }
  /** DuplicateHandle of the Job into the (simulated) watchdog process. */
  duplicateJobForWatchdog(job: NativeHandle): NativeHandle {
    return this.issue('job', this.rec(job, 'job').target, 'watchdog');
  }
  private closeRec(_h: NativeHandle, r: HandleRec): void {
    r.closed = true;
    if (r.kind === 'job') {
      const j = this.jobs.get(r.target)!;
      j.openHandles -= 1;
      if (j.openHandles === 0 && (j.flags & 0x2000) !== 0) this.killJob(j, 0); // kill-on-close
    }
  }
  openHandleCount(): number { return [...this.handles.values()].filter(r => !r.closed && r.owner === 'owner').length; }
  liveProcesses(): Proc[] { return [...this.procs.values()].filter(p => p.state !== 'exited'); }
  jobDrained(jobId: number): boolean { const j = this.jobs.get(jobId)!; return j.members.size === 0; }
  jobIdOf(h: NativeHandle): number { return this.rec(h, 'job').target; }

  port(): WindowsJobPort {
    const k = this;
    const call = (name: string): void => { k.calls.push(name); };
    const base: WindowsJobPort = {
      createJob() {
        call('createJob');
        if (k.faults.has('createJobThrows')) throw new NativeJobError('CreateJobObjectW', 5);
        const id = k.nextJob++;
        k.jobs.set(id, { id, flags: 0, limit: 0, members: new Set(), total: 0, terminated: 0, openHandles: 0 });
        const h = k.issue('job', id);
        k.handles.get(h)!.inherit = k.faults.has('inheritStuck');
        return h;
      },
      clearInherit(h) { call('clearInherit'); const r = k.rec(h); if (!k.faults.has('inheritStuck')) r.inherit = false; },
      handleFlags(h) { return k.rec(h).inherit ? 1 : 0; },
      configure(h, limit) {
        call('configure');
        const j = k.jobOf(h);
        j.flags = 0x2000 | 0x8;
        if (k.faults.has('configureDropsKillOnClose')) j.flags &= ~0x2000;
        if (k.faults.has('configureAddsBreakaway')) j.flags |= 0x800;
        j.limit = limit;
      },
      limits(h) { const j = k.jobOf(h); return { flags: j.flags, activeProcessLimit: j.limit }; },
      createSuspendedInJob(h, exe) {
        call('createSuspendedInJob');
        if (k.faults.has('createProcessThrows')) throw new NativeJobError('CreateProcessW', 2);
        const j = k.jobOf(h);
        const p = k.spawnProc(exe, k.rootScript, k.faults.has('atomicCreateNotMember') ? null : j.id, true)!;
        return k.handlesFor(p);
      },
      createSuspended(exe) {
        call('createSuspended');
        if (k.faults.has('createProcessThrows')) throw new NativeJobError('CreateProcessW', 2);
        return k.handlesFor(k.spawnProc(exe, k.rootScript, null, true)!);
      },
      assign(h, ph) {
        call('assign');
        if (k.faults.has('assignThrows')) throw new NativeJobError('AssignProcessToJobObject', 5);
        if (k.faults.has('assignSilentlyIgnored')) return;
        const j = k.jobOf(h); const p = k.procOf(ph);
        p.job = j.id; j.members.add(p.pid); j.total += 1;
      },
      isInJob(h, ph) { const j = k.jobOf(h); const p = k.procOf(ph); return p.job === j.id; },
      resume(th) {
        call('resume');
        const p = k.procOf(th);
        k.resumed = true;
        if (k.faults.has('resumeReturnsZero')) return 0;
        const previous = p.suspendCount + (k.faults.has('resumeReturnsTwo') ? 1 : 0);
        if (k.faults.has('resumeReturnsTwo')) return previous; // still suspended in reality
        p.suspendCount = Math.max(0, p.suspendCount - 1);
        if (p.suspendCount === 0 && p.state === 'suspended') { p.state = 'running'; p.startedAt = k.now; k.executedCount += 1; }
        return previous;
      },
      terminateJob(h, code) {
        call('terminateJob');
        if (k.faults.has('terminateJobThrows')) throw new NativeJobError('TerminateJobObject', 5);
        if (k.faults.has('terminateJobIneffective')) return;
        k.killJob(k.jobOf(h), code);
      },
      terminateProcess(ph, code) {
        call('terminateProcess');
        const p = k.procOf(ph);
        if (!p.script.unkillable && !k.faults.has('terminateJobIneffective')) k.exit(p, code, true);
      },
      members(h): JobMemberList {
        const j = k.jobOf(h);
        if (k.faults.has('membersThrowAfterResume') && k.resumed) throw new NativeJobError('QueryInformationJobObject', 234);
        const listed = [...j.members];
        if (k.faults.has('membersTruncated') && listed.length > 0) return { assigned: listed.length, listed: listed.slice(0, -1) };
        return { assigned: listed.length, listed };
      },
      accounting(h): JobAccounting { const j = k.jobOf(h); return { totalProcesses: j.total, activeProcesses: j.members.size, totalTerminated: j.terminated }; },
      openProcess(pid) {
        call('openProcess');
        if (k.faults.has('openProcessThrows')) throw new NativeJobError('OpenProcess', 87);
        if (!k.procs.has(pid)) throw new NativeJobError('OpenProcess', 87);
        return k.issue('process', pid);
      },
      identity(ph, pid) { const p = k.procOf(ph); if (p.pid !== pid) throw new NativeJobError('identity-pid-mismatch', null); return { pid, createdAt100ns: p.created, imagePath: p.image }; },
      hasExited(ph) { return k.procOf(ph).state === 'exited'; },
      exitCode(ph) { const p = k.procOf(ph); return p.exitCode ?? 259; },
      close(h) {
        call('close');
        const r = k.rec(h);
        if (k.faults.has('closeThrows') && r.kind === 'thread') throw new NativeJobError('CloseHandle', 6);
        k.closeRec(h, r);
      },
    };
    return base;
  }
  private handlesFor(p: Proc): NativeProcessHandles {
    return { process: this.issue('process', p.pid), thread: this.issue('thread', p.pid), pid: p.pid };
  }
}

/** Port without the atomic JOB_LIST creation path (older binding / OS). */
export function withoutAtomic(port: WindowsJobPort): WindowsJobPort {
  const { createSuspendedInJob: _omit, ...rest } = port;
  void _omit;
  return rest;
}
