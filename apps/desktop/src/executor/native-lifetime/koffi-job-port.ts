/**
 * Hark lane — H3 native: WindowsJobPort over kernel32 via an INJECTED koffi@3.3.3.
 *
 * Scope: process LIFETIME primitives only (Job Object, suspended create, resume,
 * terminate, membership/accounting read-back, identity). No token, ACL, shell,
 * network, firewall or registry API is declared here.
 *
 * koffi is NOT a dependency of this workspace and is never imported statically:
 * the caller passes the loaded module in. In this lane it is installed only on
 * the GitHub Actions Windows x64 runner (user approval 2026-10-24, CI only),
 * from a separate directory, with lifecycle scripts disabled and the tarball
 * integrity checked against the pinned sha512. Not wired into production.
 *
 * Struct offsets are the documented Windows x64 ABI; every other ABI is refused.
 */
import type { FilePinPort } from './file-pins.js';
import { NativeJobError, type JobAccounting, type JobLimitsReadback, type JobMemberList, type NativeHandle, type NativeProcessHandles, type NativeProcessIdentity, type WindowsJobPort } from './job-port.js';

export const KOFFI_PINNED_VERSION = '3.3.3';

type NativeFn = (...args: unknown[]) => unknown;
export interface KoffiLike {
  readonly version: string;
  sizeof(type: string): number;
  load(path: string): { func(declaration: string): NativeFn };
}

const ERROR_MORE_DATA = 234;
const ERROR_INSUFFICIENT_BUFFER = 122;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const STILL_ACTIVE = 259;
const RESUME_FAILED = 0xffffffff;
// CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW. No breakaway, no inherit.
const BASE_CREATE_FLAGS = 0x00000004 | 0x00000400 | 0x08000000;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d;
// SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE.
const OPEN_ACCESS = 0x00100000 | 0x00001000 | 0x00000001;
const HEAP_ZERO_MEMORY = 0x8;
const JOB_CLASS_BASIC_ACCOUNTING = 1;
const JOB_CLASS_PROCESS_ID_LIST = 3;
const JOB_CLASS_EXTENDED_LIMITS = 9;
const EXTENDED_LIMITS_SIZE = 144;
const ACCOUNTING_SIZE = 48;
const STARTUPINFOW_SIZE = 104;
const STARTUPINFOEXW_SIZE = 112;
const PROCESS_INFORMATION_SIZE = 24;
/** Member read-back capacity; must exceed the adapter's active limit (max 64). */
export const MEMBER_LIST_CAPACITY = 128;

const toHandle = (value: unknown): NativeHandle => (typeof value === 'bigint' ? value : BigInt(Number(value)));

export function createKoffiJobPort(koffi: KoffiLike, host: { platform: string; arch: string } = process): WindowsJobPort {
  if (host.platform !== 'win32' || host.arch !== 'x64') throw new NativeJobError('unsupported-host', null);
  if (koffi.version !== KOFFI_PINNED_VERSION) throw new NativeJobError(`koffi-version-${koffi.version}`, null);
  if (koffi.sizeof('uintptr_t') !== 8) throw new NativeJobError('pointer-size', null);
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (!systemRoot || !/^[A-Za-z]:\\[^\\/:*?"<>|]+$/u.test(systemRoot)) throw new NativeJobError('system-root-refused', null);
  const lib = koffi.load(`${systemRoot}\\System32\\kernel32.dll`);
  const fn = (declaration: string): NativeFn => lib.func(declaration);

  const getLastError = fn('uint32 __stdcall GetLastError()');
  const createJobObject = fn('uintptr_t __stdcall CreateJobObjectW(void *security, void *name)');
  const setInfo = fn('int __stdcall SetInformationJobObject(uintptr_t job, uint32 cls, void *data, uint32 size)');
  const queryInfo = fn('int __stdcall QueryInformationJobObject(uintptr_t job, uint32 cls, void *data, uint32 size, void *returned)');
  const setHandleInfo = fn('int __stdcall SetHandleInformation(uintptr_t handle, uint32 mask, uint32 flags)');
  const getHandleInfo = fn('int __stdcall GetHandleInformation(uintptr_t handle, void *flags)');
  const createProcess = fn('int __stdcall CreateProcessW(str16 app, void *cmd, void *pa, void *ta, int inherit, uint32 flags, void *env, str16 cwd, void *si, void *pi)');
  const getProcessHeap = fn('uintptr_t __stdcall GetProcessHeap()');
  const heapAlloc = fn('uintptr_t __stdcall HeapAlloc(uintptr_t heap, uint32 flags, uintptr_t bytes)');
  const heapFree = fn('int __stdcall HeapFree(uintptr_t heap, uint32 flags, uintptr_t mem)');
  const moveToRaw = fn('void __stdcall RtlMoveMemory(uintptr_t dst, void *src, uintptr_t length)');
  const initAttrs = fn('int __stdcall InitializeProcThreadAttributeList(uintptr_t list, uint32 count, uint32 flags, void *size)');
  const updateAttr = fn('int __stdcall UpdateProcThreadAttribute(uintptr_t list, uint32 flags, uintptr_t attribute, uintptr_t value, uintptr_t size, void *prev, void *retsize)');
  const deleteAttrs = fn('void __stdcall DeleteProcThreadAttributeList(uintptr_t list)');
  const assignProcess = fn('int __stdcall AssignProcessToJobObject(uintptr_t job, uintptr_t process)');
  const isProcessInJob = fn('int __stdcall IsProcessInJob(uintptr_t process, uintptr_t job, void *result)');
  const resumeThread = fn('uint32 __stdcall ResumeThread(uintptr_t thread)');
  const terminateJobObject = fn('int __stdcall TerminateJobObject(uintptr_t job, uint32 code)');
  const terminateProcess = fn('int __stdcall TerminateProcess(uintptr_t process, uint32 code)');
  const openProcess = fn('uintptr_t __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
  const waitForSingleObject = fn('uint32 __stdcall WaitForSingleObject(uintptr_t handle, uint32 ms)');
  const getExitCodeProcess = fn('int __stdcall GetExitCodeProcess(uintptr_t process, void *code)');
  const getProcessTimes = fn('int __stdcall GetProcessTimes(uintptr_t process, void *created, void *exited, void *kernel, void *user)');
  const queryImageName = fn('int __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32 flags, void *buffer, void *size)');
  const closeHandle = fn('int __stdcall CloseHandle(uintptr_t handle)');

  const lastError = (): number => Number(getLastError());
  const check = (ok: unknown, operation: string): void => {
    if (!ok) throw new NativeJobError(operation, lastError());
  };
  const query = (job: NativeHandle, cls: number, size: number, operation: string): Buffer => {
    const out = Buffer.alloc(size);
    check(queryInfo(job, cls, out, size, null), operation);
    return out;
  };
  const toProcessInfo = (pi: Buffer): NativeProcessHandles => ({
    process: pi.readBigUInt64LE(0),
    thread: pi.readBigUInt64LE(8),
    pid: pi.readUInt32LE(16),
  });
  const commandBuffer = (commandLine: string): Buffer => Buffer.from(`${commandLine}\0`, 'utf16le');

  return {
    createJob() {
      const job = toHandle(createJobObject(null, null));
      if (job === 0n) throw new NativeJobError('CreateJobObjectW', lastError());
      return job;
    },
    clearInherit(handle) {
      check(setHandleInfo(handle, 0x1, 0), 'SetHandleInformation');
    },
    handleFlags(handle) {
      const out = Buffer.alloc(4);
      check(getHandleInfo(handle, out), 'GetHandleInformation');
      return out.readUInt32LE(0);
    },
    configure(job, activeProcessLimit) {
      const info = Buffer.alloc(EXTENDED_LIMITS_SIZE);
      info.writeUInt32LE(0x2000 | 0x8, 16); // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS, nothing else
      info.writeUInt32LE(activeProcessLimit, 40);
      check(setInfo(job, JOB_CLASS_EXTENDED_LIMITS, info, EXTENDED_LIMITS_SIZE), 'SetInformationJobObject');
    },
    limits(job): JobLimitsReadback {
      const info = query(job, JOB_CLASS_EXTENDED_LIMITS, EXTENDED_LIMITS_SIZE, 'QueryInformationJobObject(limits)');
      return { flags: info.readUInt32LE(16), activeProcessLimit: info.readUInt32LE(40) };
    },
    createSuspendedInJob(job, executable, commandLine, cwd, environmentBlock) {
      const heap = toHandle(getProcessHeap());
      const sizeOut = Buffer.alloc(8);
      // First call only reports the size; it is documented to fail with INSUFFICIENT_BUFFER.
      if (initAttrs(0n, 1, 0, sizeOut) || lastError() !== ERROR_INSUFFICIENT_BUFFER) {
        throw new NativeJobError('InitializeProcThreadAttributeList(size)', lastError());
      }
      const listSize = sizeOut.readBigUInt64LE(0);
      const list = toHandle(heapAlloc(heap, HEAP_ZERO_MEMORY, listSize));
      if (list === 0n) throw new NativeJobError('HeapAlloc(attribute-list)', null);
      // The JOB_LIST value must stay valid until the list is deleted: raw heap, not a JS buffer.
      const jobArray = toHandle(heapAlloc(heap, HEAP_ZERO_MEMORY, 8n));
      let initialised = false;
      try {
        if (jobArray === 0n) throw new NativeJobError('HeapAlloc(job-list)', null);
        const handleBytes = Buffer.alloc(8);
        handleBytes.writeBigUInt64LE(job, 0);
        moveToRaw(jobArray, handleBytes, 8n);
        check(initAttrs(list, 1, 0, sizeOut), 'InitializeProcThreadAttributeList');
        initialised = true;
        check(updateAttr(list, 0, BigInt(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobArray, 8n, null, null), 'UpdateProcThreadAttribute(JOB_LIST)');
        const si = Buffer.alloc(STARTUPINFOEXW_SIZE);
        si.writeUInt32LE(STARTUPINFOEXW_SIZE, 0);
        si.writeBigUInt64LE(list, STARTUPINFOW_SIZE);
        const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE);
        check(
          createProcess(executable, commandBuffer(commandLine), null, null, 0, BASE_CREATE_FLAGS | EXTENDED_STARTUPINFO_PRESENT, Buffer.from(environmentBlock), cwd, si, pi),
          'CreateProcessW(JOB_LIST)',
        );
        return toProcessInfo(pi);
      } finally {
        if (initialised) deleteAttrs(list);
        heapFree(heap, 0, list);
        if (jobArray !== 0n) heapFree(heap, 0, jobArray);
      }
    },
    createSuspended(executable, commandLine, cwd, environmentBlock) {
      const si = Buffer.alloc(STARTUPINFOW_SIZE);
      si.writeUInt32LE(STARTUPINFOW_SIZE, 0);
      const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE);
      check(createProcess(executable, commandBuffer(commandLine), null, null, 0, BASE_CREATE_FLAGS, Buffer.from(environmentBlock), cwd, si, pi), 'CreateProcessW');
      return toProcessInfo(pi);
    },
    assign(job, processHandle) {
      check(assignProcess(job, processHandle), 'AssignProcessToJobObject');
    },
    isInJob(job, processHandle) {
      const out = Buffer.alloc(4);
      check(isProcessInJob(processHandle, job, out), 'IsProcessInJob');
      return out.readInt32LE(0) !== 0;
    },
    resume(thread) {
      const previous = Number(resumeThread(thread));
      if (previous === RESUME_FAILED) throw new NativeJobError('ResumeThread', lastError());
      return previous;
    },
    terminateJob(job, exitCode) {
      check(terminateJobObject(job, exitCode), 'TerminateJobObject');
    },
    terminateProcess(processHandle, exitCode) {
      check(terminateProcess(processHandle, exitCode), 'TerminateProcess');
    },
    members(job): JobMemberList {
      const size = 8 + MEMBER_LIST_CAPACITY * 8;
      const out = Buffer.alloc(size);
      if (!queryInfo(job, JOB_CLASS_PROCESS_ID_LIST, out, size, null)) {
        const code = lastError();
        // MORE_DATA still fills the header: report it truncated (assigned > listed), never complete.
        if (code !== ERROR_MORE_DATA) throw new NativeJobError('QueryInformationJobObject(members)', code);
      }
      const assigned = out.readUInt32LE(0);
      const listed = Math.min(out.readUInt32LE(4), MEMBER_LIST_CAPACITY);
      return { assigned, listed: Array.from({ length: listed }, (_, i) => Number(out.readBigUInt64LE(8 + i * 8))) };
    },
    accounting(job): JobAccounting {
      const info = query(job, JOB_CLASS_BASIC_ACCOUNTING, ACCOUNTING_SIZE, 'QueryInformationJobObject(accounting)');
      return { totalProcesses: info.readUInt32LE(36), activeProcesses: info.readUInt32LE(40), totalTerminated: info.readUInt32LE(44) };
    },
    openProcess(pid) {
      const handle = toHandle(openProcess(OPEN_ACCESS, 0, pid));
      if (handle === 0n) throw new NativeJobError('OpenProcess', lastError());
      return handle;
    },
    identity(processHandle, pid): NativeProcessIdentity {
      const created = Buffer.alloc(8);
      const scratch = Buffer.alloc(24);
      check(getProcessTimes(processHandle, created, scratch.subarray(0, 8), scratch.subarray(8, 16), scratch.subarray(16, 24)), 'GetProcessTimes');
      const chars = 32_768;
      const name = Buffer.alloc(chars * 2);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(chars, 0);
      check(queryImageName(processHandle, 0, name, length), 'QueryFullProcessImageNameW');
      return { pid, createdAt100ns: created.readBigUInt64LE(0).toString(), imagePath: name.toString('utf16le', 0, length.readUInt32LE(0) * 2) };
    },
    hasExited(processHandle) {
      const state = Number(waitForSingleObject(processHandle, 0));
      if (state === WAIT_OBJECT_0) return true;
      if (state === WAIT_TIMEOUT) return false;
      throw new NativeJobError('WaitForSingleObject', lastError());
    },
    exitCode(processHandle) {
      const out = Buffer.alloc(4);
      check(getExitCodeProcess(processHandle, out), 'GetExitCodeProcess');
      const code = out.readUInt32LE(0);
      // STILL_ACTIVE is ambiguous; only trust it once the handle is signalled.
      if (code === STILL_ACTIVE && Number(waitForSingleObject(processHandle, 0)) !== WAIT_OBJECT_0) {
        throw new NativeJobError('exit-code-still-active', null);
      }
      return code;
    },
    close(handle) {
      check(closeHandle(handle), 'CloseHandle');
    },
  };
}

/** H4: least-privilege handle transfer into a process the owner created (watchdog). */
export interface NativeHandleTransfer {
  /** Pseudo handle of the calling process; only meaningful as a DuplicateHandle source. */
  currentProcessHandle(): NativeHandle;
  /** Duplicate `handle` into `targetProcess` with exactly `access` (never SAME_ACCESS); returns the value valid in the target. */
  duplicateInto(targetProcess: NativeHandle, handle: NativeHandle, access: number): NativeHandle;
}

/** JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE — all the watchdog needs on the Job. */
export const WATCHDOG_JOB_ACCESS = 0x0004 | 0x0008;
/** SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION — watch the owner, nothing more. */
export const WATCHDOG_OWNER_ACCESS = 0x00100000 | 0x00001000;

export function createKoffiHandleTransfer(koffi: KoffiLike, host: { platform: string; arch: string } = process): NativeHandleTransfer {
  if (host.platform !== 'win32' || host.arch !== 'x64') throw new NativeJobError('unsupported-host', null);
  if (koffi.version !== KOFFI_PINNED_VERSION || koffi.sizeof('uintptr_t') !== 8) throw new NativeJobError('binding-refused', null);
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (!systemRoot || !/^[A-Za-z]:\\[^\\/:*?"<>|]+$/u.test(systemRoot)) throw new NativeJobError('system-root-refused', null);
  const lib = koffi.load(`${systemRoot}\\System32\\kernel32.dll`);
  const getLastError = lib.func('uint32 __stdcall GetLastError()');
  const getCurrentProcess = lib.func('uintptr_t __stdcall GetCurrentProcess()');
  const duplicate = lib.func('int __stdcall DuplicateHandle(uintptr_t srcProcess, uintptr_t src, uintptr_t dstProcess, void *dst, uint32 access, int inherit, uint32 options)');
  return {
    currentProcessHandle: () => toHandle(getCurrentProcess()),
    duplicateInto(targetProcess, handle, access) {
      if (!Number.isSafeInteger(access) || access <= 0) throw new NativeJobError('duplicate-access-refused', null);
      const out = Buffer.alloc(8);
      if (!duplicate(toHandle(getCurrentProcess()), handle, targetProcess, out, access, 0, 0)) {
        throw new NativeJobError('DuplicateHandle', Number(getLastError()));
      }
      const value = out.readBigUInt64LE(0);
      if (value === 0n) throw new NativeJobError('DuplicateHandle-null', null);
      return value;
    },
  };
}

/**
 * H5: FilePinPort over kernel32 (see file-pins.ts). Files: GENERIC_READ, share
 * READ only. Directories: FILE_LIST_DIRECTORY (so the share mode is enforced) |
 * FILE_READ_ATTRIBUTES | SYNCHRONIZE, share READ|WRITE (deny DELETE). Both with
 * FILE_FLAG_OPEN_REPARSE_POINT so a link is pinned as itself and then refused.
 */
export function createKoffiFilePinPort(koffi: KoffiLike, host: { platform: string; arch: string } = process): FilePinPort {
  if (host.platform !== 'win32' || host.arch !== 'x64') throw new NativeJobError('unsupported-host', null);
  if (koffi.version !== KOFFI_PINNED_VERSION || koffi.sizeof('uintptr_t') !== 8) throw new NativeJobError('binding-refused', null);
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  if (!systemRoot || !/^[A-Za-z]:\\[^\\/:*?"<>|]+$/u.test(systemRoot)) throw new NativeJobError('system-root-refused', null);
  const lib = koffi.load(`${systemRoot}\\System32\\kernel32.dll`);
  const getLastError = lib.func('uint32 __stdcall GetLastError()');
  const createFile = lib.func('uintptr_t __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *sa, uint32 disposition, uint32 flags, uintptr_t template)');
  const getInfo = lib.func('int __stdcall GetFileInformationByHandle(uintptr_t handle, void *info)');
  const getFinalPath = lib.func('uint32 __stdcall GetFinalPathNameByHandleW(uintptr_t handle, void *buffer, uint32 chars, uint32 flags)');
  const readFile = lib.func('int __stdcall ReadFile(uintptr_t handle, void *buffer, uint32 bytes, void *read, void *overlapped)');
  const closeHandle = lib.func('int __stdcall CloseHandle(uintptr_t handle)');
  const INVALID = 0xffffffffffffffffn;
  const OPEN_EXISTING = 3;
  const OPEN_REPARSE = 0x00200000;
  const BACKUP_SEMANTICS = 0x02000000;
  const open = (path: string, access: number, share: number, flags: number, op: string): NativeHandle => {
    if (path.includes('\0') || !/^[A-Za-z]:\\/u.test(path)) throw new NativeJobError(`${op}-path-refused`, null);
    const h = toHandle(createFile(path, access, share, null, OPEN_EXISTING, flags, 0n));
    if (h === INVALID || h === 0n) throw new NativeJobError(op, Number(getLastError()));
    return h;
  };
  return {
    openFilePinned: path => open(path, 0x80000000, 0x1, OPEN_REPARSE | 0x08000000, 'CreateFileW(pin-file)'),
    openDirectoryPinned: path => open(path, 0x1 | 0x80 | 0x00100000, 0x1 | 0x2, OPEN_REPARSE | BACKUP_SEMANTICS, 'CreateFileW(pin-dir)'),
    info(handle) {
      const b = Buffer.alloc(52);
      if (!getInfo(handle, b)) throw new NativeJobError('GetFileInformationByHandle', Number(getLastError()));
      const chars = 32_768;
      const name = Buffer.alloc(chars * 2);
      const n = Number(getFinalPath(handle, name, chars, 0));
      if (n === 0 || n >= chars) throw new NativeJobError('GetFinalPathNameByHandleW', Number(getLastError()));
      return {
        finalPath: name.toString('utf16le', 0, n * 2),
        attributes: b.readUInt32LE(0),
        volumeSerial: b.readUInt32LE(28),
        size: b.readUInt32LE(32) * 2 ** 32 + b.readUInt32LE(36),
        links: b.readUInt32LE(40),
        fileIndex: ((BigInt(b.readUInt32LE(44)) << 32n) | BigInt(b.readUInt32LE(48))).toString(),
      };
    },
    read(handle, into) {
      const view = Buffer.from(into.buffer, into.byteOffset, into.byteLength);
      const got = Buffer.alloc(4);
      if (!readFile(handle, view, Math.min(view.length, 0x7fffffff), got, null)) throw new NativeJobError('ReadFile', Number(getLastError()));
      return got.readUInt32LE(0);
    },
    close(handle) {
      if (!closeHandle(handle)) throw new NativeJobError('CloseHandle(pin)', Number(getLastError()));
    },
  };
}
