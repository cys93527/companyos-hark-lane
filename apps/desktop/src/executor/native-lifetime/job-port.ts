/**
 * Hark lane — Phase 3B-3E: Windows Job lifetime PORT (types only, no binding).
 *
 * This file deliberately imports NO native module. The concrete Win32 binding
 * (koffi@3.3.3 candidate) is NOT approved for this lane; until it is, the only
 * implementations of this port are the deterministic offline fake kernel used
 * by tests. Nothing here grants execution permission, isolation, budget or a
 * canonical settlement: a Job Object controls process LIFETIME only.
 */

export type NativeHandle = bigint;

export interface NativeProcessHandles {
  readonly process: NativeHandle;
  readonly thread: NativeHandle;
  readonly pid: number;
}

/** PID alone is reusable; creation time + full image path pin the identity. */
export interface NativeProcessIdentity {
  readonly pid: number;
  readonly createdAt100ns: string;
  readonly imagePath: string;
}

/** JOBOBJECT_BASIC_PROCESS_ID_LIST read-back: BOTH counts are kept so a
 * truncated list (assigned > listed) can never pass as a complete one. */
export interface JobMemberList {
  readonly assigned: number;
  readonly listed: readonly number[];
}

export interface JobAccounting {
  readonly totalProcesses: number;
  readonly activeProcesses: number;
  readonly totalTerminated: number;
}

export interface JobLimitsReadback {
  readonly flags: number;
  readonly activeProcessLimit: number;
}

/** H7: anonymous pipe; the write end is inheritable, the read end is not. */
export interface OutputPipe { readonly read: NativeHandle; readonly write: NativeHandle }
export interface StdioHandles { readonly stdout: NativeHandle; readonly stderr: NativeHandle }

export interface WindowsJobPort {
  createJob(): NativeHandle;
  /** Clear HANDLE_FLAG_INHERIT on the Job handle; must be read back separately. */
  clearInherit(handle: NativeHandle): void;
  handleFlags(handle: NativeHandle): number;
  configure(job: NativeHandle, activeProcessLimit: number): void;
  limits(job: NativeHandle): JobLimitsReadback;
  /**
   * PREFERRED: CreateProcessW with STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_JOB_LIST,
   * so the child is a Job member from its first instant. Closes the window in
   * which an owner crash between create and assign leaves a suspended orphan
   * outside any kill-on-close Job. Optional: a binding may not offer it.
   */
  createSuspendedInJob?(
    job: NativeHandle,
    executable: string,
    commandLine: string,
    cwd: string,
    environmentBlock: Uint8Array,
    /** H7: inherit EXACTLY these two write ends (PROC_THREAD_ATTRIBUTE_HANDLE_LIST); nothing else. */
    stdio?: StdioHandles,
  ): NativeProcessHandles;
  /** H7 output capture (optional; atomic launch only). */
  createOutputPipe?(): OutputPipe;
  /** Bytes ready to read without blocking; 0 = none yet; -1 = all writers closed and empty (EOF). */
  pipeAvailable?(read: NativeHandle): number;
  /** Reads at most `max` bytes; only called with max <= pipeAvailable(). */
  readPipe?(read: NativeHandle, max: number): Uint8Array;
  /** LEGACY: CREATE_SUSPENDED outside the Job; caller must assign before resume. */
  createSuspended(
    executable: string,
    commandLine: string,
    cwd: string,
    environmentBlock: Uint8Array,
  ): NativeProcessHandles;
  assign(job: NativeHandle, process: NativeHandle): void;
  isInJob(job: NativeHandle, process: NativeHandle): boolean;
  /** Returns the PREVIOUS suspend count (Win32 ResumeThread semantics). */
  resume(thread: NativeHandle): number;
  terminateJob(job: NativeHandle, exitCode: number): void;
  terminateProcess(process: NativeHandle, exitCode: number): void;
  members(job: NativeHandle): JobMemberList;
  accounting(job: NativeHandle): JobAccounting;
  openProcess(pid: number): NativeHandle;
  identity(process: NativeHandle, pid: number): NativeProcessIdentity;
  hasExited(process: NativeHandle): boolean;
  exitCode(process: NativeHandle): number;
  close(handle: NativeHandle): void;
}

export class NativeJobError extends Error {
  readonly operation: string;
  readonly nativeCode: number | null;
  constructor(operation: string, nativeCode: number | null) {
    super(`Windows job operation failed: ${operation}${nativeCode === null ? '' : ` (${nativeCode})`}.`);
    this.name = 'NativeJobError';
    this.operation = operation;
    this.nativeCode = nativeCode;
  }
}

export const HANDLE_FLAG_INHERIT = 0x1;
export const JOB_LIMIT_ACTIVE_PROCESS = 0x8;
export const JOB_LIMIT_BREAKAWAY_OK = 0x800;
export const JOB_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
export const JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
export const JOB_REQUIRED_FLAGS = JOB_LIMIT_KILL_ON_JOB_CLOSE | JOB_LIMIT_ACTIVE_PROCESS;
export const JOB_FORBIDDEN_FLAGS = JOB_LIMIT_BREAKAWAY_OK | JOB_LIMIT_SILENT_BREAKAWAY_OK;
/** Distinct, recognisable exit code for CompanyOS-initiated stops. */
export const COMPANYOS_STOP_EXIT_CODE = 0xe0003e02;
