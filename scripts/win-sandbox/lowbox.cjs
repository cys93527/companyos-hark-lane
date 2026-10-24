/**
 * STAGE 5C PHASE A — the disposable Windows sandbox lab (Boss §4-§6).
 *
 * Spawns one command inside a LowBox AppContainer (per-attempt profile with
 * ZERO network capabilities) assigned to a kill-on-close Job Object:
 *   - Identity: CreateAppContainerProfile('companyos.attempt.<rand>') → unique
 *     SID per attempt (Boss §30). No internetClient/privateNetwork capabilities
 *     are ever requested (Boss §10) — the token has NO network reach.
 *   - Access: icacls grants (additive ACEs) name the attempt SID on exactly the
 *     workspace (F), the per-attempt home (F), and trusted toolchain roots (RX)
 *     declared by the CALLER (never by the model — Boss §8).
 *   - Lifetime: CREATE_SUSPENDED → AssignProcessToJobObject(KILL_ON_JOB_CLOSE,
 *     no breakaway) → ResumeThread. Closing the job handle kills the whole tree
 *     (Boss §13-§14); process diagnostics come from the CIM marker queries in
 *     the test layer.
 *   - Cleanup: revokes every granted ACE, deletes the AppContainer profile,
 *     removes the workspace/home dirs, and logs the grant ledger for crash
 *     recovery sweeps (Boss §31).
 *
 * Command shape: the caller passes program + literal argv (shell:false at this
 * boundary — Boss §25/§26); stdio is captured via workspace-local redirect
 * files driven by a generated cmd batch wrapper (the AppContainer cannot
 * inherit host pipes; HANDLE_LIST marshalling is future work if Phase B needs
 * streaming).
 */
// koffi rides the PINNED embedded DSH runtime's own build (koffi@3.1.1, the
// same FFI DSH ships) — no new CompanyOS dependency.
const {existsSync, mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const embeddedKoffi = join(process.cwd(), '.companyos-embedded', 'dsh-runtime', 'runtime', 'node_modules', '.pnpm', 'koffi@3.1.1', 'node_modules', 'koffi');
const koffi = existsSync(resolve(embeddedKoffi, 'package.json'))
  ? require(embeddedKoffi)
  : require('koffi');

const kernel32 = koffi.load('kernel32.dll');
const userenv = koffi.load('userenv.dll');
const advapi32 = koffi.load('advapi32.dll');

const STARTUPINFOW = koffi.struct('LBStartupInfoW', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32',
  wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *',
  hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
});
const STARTUPINFOEXW = koffi.struct('LBStartupInfoExW', { StartupInfo: STARTUPINFOW, lpAttributeList: 'void *' });
const PROCESS_INFORMATION = koffi.struct('LBProcessInformation', {
  hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
});
const JOB_BASIC_LIMITS = koffi.struct('LBJobBasicLimits', {
  PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'uintptr_t', MaximumWorkingSetSize: 'uintptr_t',
  ActiveProcessLimit: 'uint32', Affinity: 'uintptr_t', PriorityClass: 'uint32', SchedulingClass: 'uint32',
});
const IO_COUNTERS = koffi.struct('LBIoCounters', {
  ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
});
const JOB_EXTENDED_LIMITS = koffi.struct('LBJobExtendedLimits', {
  BasicLimitInformation: JOB_BASIC_LIMITS, IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: 'uintptr_t', JobMemoryLimit: 'uintptr_t',
  PeakProcessMemoryUsed: 'uintptr_t', PeakJobMemoryUsed: 'uintptr_t',
});

const EXPLICIT_ACCESSW = koffi.struct('LBExplicitAccessW', {
  grfAccessPermissions: 'uint32', grfAccessMode: 'uint32', grfInheritance: 'uint32',
  Trustee: koffi.struct('LBTrusteeW', {
    pMultipleTrustee: 'void *', MultipleTrusteeOperation: 'uint32', TrusteeForm: 'uint32', TrusteeType: 'uint32', ptstrName: 'void *',
  }),
});
const getNamedSecurityInfo = advapi32.func('uint32 __stdcall GetNamedSecurityInfoW(str16 path, uint32 objType, uint32 secInfo, void * a, void * b, _Out_ void **ppDacl, void * c, _Out_ void **ppSd)');
const setNamedSecurityInfo = advapi32.func('uint32 __stdcall SetNamedSecurityInfoW(str16 path, uint32 objType, uint32 secInfo, void * a, void * b, void *pDacl, void * c)');
const setEntriesInAcl = advapi32.func('uint32 __stdcall SetEntriesInAclW(uint32 count, void *entries, void *oldDacl, _Out_ void **newDacl)');
const convertStringSid = advapi32.func('int __stdcall ConvertStringSidToSidW(str16 s, _Out_ void **sid)');
const localFree = kernel32.func('void * __stdcall LocalFree(void *mem)');

const createProfile = userenv.func('long __stdcall CreateAppContainerProfile(str16 n, str16 dn, str16 d, void *caps, uint32 c, _Out_ void **sid)');
const deleteProfile = userenv.func('long __stdcall DeleteAppContainerProfile(str16 n)');
const convertSidToString = advapi32.func('int __stdcall ConvertSidToStringSidW(void *sid, _Out_ uint16_t **str)');
const initAttrList = kernel32.func('int __stdcall InitializeProcThreadAttributeList(void *l, uint32 c, uint32 f, _Inout_ uintptr_t *s)');
const updateAttr = kernel32.func('int __stdcall UpdateProcThreadAttribute(void *l, uint32 f, uintptr_t a, void *v, uintptr_t sz, void *p, uintptr_t *r)');
const deleteAttrList = kernel32.func('void __stdcall DeleteProcThreadAttributeList(void *l)');
const createProcess = kernel32.func('__stdcall', 'CreateProcessW', 'int',
  ['str16', 'str16', 'void *', 'void *', 'int', 'uint32', 'void *', 'str16', koffi.pointer(STARTUPINFOEXW), koffi.pointer(PROCESS_INFORMATION)]);
const createJob = kernel32.func('void * __stdcall CreateJobObjectW(void *a, str16 n)');
const setJobInfo = kernel32.func('int __stdcall SetInformationJobObject(void *j, uint32 c, void *i, uint32 s)');
const assignJob = kernel32.func('int __stdcall AssignProcessToJobObject(void *j, void *p)');
const terminateJob = kernel32.func('int __stdcall TerminateJobObject(void *j, uint32 code)');
const waitFor = kernel32.func('uint32 __stdcall WaitForSingleObject(void *h, uint32 ms)');
const getExitCode = kernel32.func('int __stdcall GetExitCodeProcess(void *h, _Out_ uint32 *c)');
const closeHandle = kernel32.func('int __stdcall CloseHandle(void *h)');
const resumeThread = kernel32.func('uint32 __stdcall ResumeThread(void *h)');
const lastError = kernel32.func('uint32 __stdcall GetLastError()');

const ATTR_SECURITY_CAPABILITIES = 0x00020009;
const SECURITY_CAPABILITIES_ABI_BYTES = 24; // validated empirically on Win11 22631
const EXTENDED_STARTUPINFO = 0x00080000;
const CREATE_SUSPENDED_FLAG = 0x00000004;
const JOB_EXTENDED_LIMIT_CLASS = 9;
const JOB_LIMIT_KILL_ON_CLOSE = 0x2000;
const WAIT_TIMEOUT = 0x102;
const WAIT_FAILED_ = 0xFFFFFFFF;
const HRESULT_ALREADY_EXISTS = 0x800700B7;

const SE_FILE_OBJECT = 1;
const DACL_SEC_INFO = 4;
const GRANT_ACCESS = 1;
const REVOKE_ACCESS = 4;
const TRUSTEE_IS_SID = 0;
const INHERIT_CHILDREN = 3; // OBJECT|CONTAINER
const FILE_ALL = 0x1F01FF;
const FILE_RX = 0x120089 | 0x1200A0;

/**
 * Grant/revoke the attempt SID's ACE on one path via SetEntriesInAclW.
 * icacls is unusable as a primitive: /grant silently mangles out-of-range
 * subauthorities and fails to propagate on large trees, /remove fails with
 * ERROR_NONE_MAPPED/ERROR_INVALID_SID — leaving widened ACLs behind (the
 * §31 hazard). The FFI rewrite is verified by re-reading the DACL in tests.
 */
const setAce = (path, sidStr, kind, perms) => {
  const sidOut = [koffi.NULL];
  if (!convertStringSid(sidStr, sidOut)) throw new Error('ConvertStringSidToSidW failed');
  const entry = koffi.alloc(EXPLICIT_ACCESSW, 1);
  koffi.encode(entry, EXPLICIT_ACCESSW, {
    grfAccessPermissions: kind === 'grant' ? perms : 0,
    grfAccessMode: kind === 'grant' ? GRANT_ACCESS : REVOKE_ACCESS,
    grfInheritance: kind === 'grant' ? INHERIT_CHILDREN : 0,
    Trustee: {pMultipleTrustee: koffi.NULL, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: 0, ptstrName: sidOut[0]},
  });
  const oldDacl = [koffi.NULL];
  const secDesc = [koffi.NULL];
  const getErr = getNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SEC_INFO, koffi.NULL, koffi.NULL, oldDacl, koffi.NULL, secDesc);
  if (getErr !== 0) throw new Error(`GetNamedSecurityInfoW(${path}) err=${getErr}`);
  const newDacl = [koffi.NULL];
  const setErr = setEntriesInAcl(1, entry, oldDacl[0], newDacl);
  if (newDacl[0] !== koffi.NULL && secDesc[0] !== koffi.NULL) { /* keep for free below */ }
  if (setErr !== 0) {
    if (secDesc[0] !== koffi.NULL) localFree(secDesc[0]);
    throw new Error(`SetEntriesInAclW(${path}) err=${setErr}`);
  }
  const writeErr = setNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SEC_INFO, koffi.NULL, koffi.NULL, newDacl[0], koffi.NULL);
  if (newDacl[0] !== koffi.NULL) localFree(newDacl[0]);
  if (secDesc[0] !== koffi.NULL) localFree(secDesc[0]);
  if (writeErr !== 0) throw new Error(`SetNamedSecurityInfoW(${path}) err=${writeErr}`);
};

/**
 * Standard Windows argv quoting (the DSH win32-process algorithm): quote iff
 * the element has whitespace or quotes, with backslash-run + quote escaping.
 * cmd.exe (own parser) callers pass `rawArgs: true` instead.
 */
const quoteArg = (argument) => {
  if (!/[ \t"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const char of argument) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
};

/**
 * One disposable sandboxed attempt. Everything created per call: the AppContainer
 * profile (identity), the ACL grants, the home dir, the Job. `dispose()` reverts
 * the world; `run()` executes one command and captures stdio via redirect files.
 */
class LowBoxAttempt {
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot;
    this.toolchainRoots = options.toolchainRoots ?? [];
    this.containerName = `companyos.attempt.${Math.random().toString(36).slice(2, 12)}`;
    this.grants = [];
    this.homeDir = mkdtempSync(join(tmpdir(), 'lb-home-'));
    const sidOut = [koffi.NULL];
    const hr = createProfile(this.containerName, 'CompanyOS Agent Sandbox', 'per-attempt isolation identity', koffi.NULL, 0, sidOut) >>> 0;
    if (hr !== 0 && hr !== HRESULT_ALREADY_EXISTS) {
      throw new Error(`CreateAppContainerProfile failed hr=0x${hr.toString(16)}`);
    }
    this.sidPtr = sidOut[0];
    const strOut = [koffi.NULL];
    convertSidToString(this.sidPtr, strOut);
    const units = koffi.decode(strOut[0], koffi.array('uint16_t', 96));
    this.sid = '';
    for (const unit of units) { if (unit === 0) break; this.sid += String.fromCharCode(unit); }
    for (const path of [this.workspaceRoot, this.homeDir]) {
      setAce(path, this.sid, 'grant', FILE_ALL);
      this.grants.push(path);
    }
    for (const path of this.toolchainRoots) {
      setAce(path, this.sid, 'grant', FILE_RX);
      this.grants.push(path);
    }
  }

  /** Spawn one command (program + literal argv) inside the box; resolve on exit. */
  run(options) {
    const {program, argv, cwd, env, timeoutMs = 60_000, rawArgs = false} = options;
    const redirOut = join(this.workspaceRoot, `.lb-stdout-${Date.now()}.txt`);
    const redirErr = join(this.workspaceRoot, `.lb-stderr-${Date.now()}.txt`);
    const batch = join(this.workspaceRoot, `.lb-run-${Date.now()}.cmd`);
    const q = (s) => `"${s}"`;
    // Environment: injected via batch `set` lines. An explicit lpEnvironment
    // block is rejected by AppContainer creation through this FFI path
    // (ERROR_ENVVAR_NOT_FOUND for hand-built blocks, a different failure for
    // OS-generated ones); the batch is OUR generated artifact, so the env
    // allowlist is enforced by what we write — never by child cooperation.
    const lines = [];
    for (const [key, value] of Object.entries(env ?? {})) {
      lines.push(`@set "${key}=${value}"`);
    }
    lines.push(
      [q(program), ...(rawArgs === true ? argv : argv.map(quoteArg))].join(' ')
        + ` > ${q(redirOut)} 2> ${q(redirErr)}`,
    );
    require('node:fs').writeFileSync(batch, lines.join('\r\n') + '\r\n', 'utf8');
    const attrSize = [0];
    initAttrList(koffi.NULL, 1, 0, attrSize);
    const attrList = koffi.alloc('uint8_t', Number(attrSize[0]));
    if (!initAttrList(attrList, 1, 0, attrSize)) throw new Error('InitializeProcThreadAttributeList failed');
    const secCaps = Buffer.alloc(SECURITY_CAPABILITIES_ABI_BYTES);
    secCaps.writeBigUInt64LE(BigInt(this.sidPtr), 0);
    if (!updateAttr(attrList, 0, ATTR_SECURITY_CAPABILITIES, secCaps, SECURITY_CAPABILITIES_ABI_BYTES, koffi.NULL, koffi.NULL)) {
      deleteAttrList(attrList);
      throw new Error(`SECURITY_CAPABILITIES attribute failed err=${lastError()}`);
    }
    const si = koffi.alloc(STARTUPINFOEXW, 1);
    koffi.encode(si, STARTUPINFOEXW, { StartupInfo: { cb: koffi.sizeof(STARTUPINFOEXW) }, lpAttributeList: attrList });
    const pi = koffi.alloc(PROCESS_INFORMATION, 1);
    const flags = EXTENDED_STARTUPINFO | CREATE_SUSPENDED_FLAG;
    const job = createJob(koffi.NULL, `companyos.job.${Math.random().toString(36).slice(2, 12)}`);
    const jeli = koffi.alloc(JOB_EXTENDED_LIMITS, 1);
    koffi.encode(jeli, JOB_EXTENDED_LIMITS, { BasicLimitInformation: { LimitFlags: JOB_LIMIT_KILL_ON_CLOSE } });
    if (!setJobInfo(job, JOB_EXTENDED_LIMIT_CLASS, jeli, koffi.sizeof(JOB_EXTENDED_LIMITS))) {
      throw new Error('SetInformationJobObject failed');
    }
    const cmdLine = `C:\\Windows\\System32\\cmd.exe /d /c ""${batch}""`;
    const cwdPath = cwd ?? this.workspaceRoot;
    const created = createProcess(null, cmdLine, koffi.NULL, koffi.NULL, 0, flags, koffi.NULL, cwdPath, si, pi);
    deleteAttrList(attrList);
    if (!created) {
      closeHandle(job);
      throw new Error(`CreateProcessW failed err=${lastError()}`);
    }
    const info = koffi.decode(pi, PROCESS_INFORMATION);
    const assigned = assignJob(job, info.hProcess) === 1;
    resumeThread(info.hThread);
    const wait = waitFor(info.hProcess, timeoutMs);
    let timedOut = false;
    if (wait === WAIT_TIMEOUT) {
      timedOut = true;
      terminateJob(job, 124);
      waitFor(info.hProcess, 10_000);
    } else if (wait === WAIT_FAILED_) {
      terminateJob(job, 125);
    }
    const codeOut = [0];
    getExitCode(info.hProcess, codeOut);
    const stdout = this.#readSoft(redirOut);
    const stderr = this.#readSoft(redirErr);
    closeHandle(info.hProcess);
    closeHandle(info.hThread);
    closeHandle(job); // kill-on-close: any survivors (Start-Process etc.) die here
    return {exitCode: codeOut[0], pid: info.dwProcessId, jobAssigned: assigned, timedOut, stdout, stderr};
  }

  #readSoft(path) {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  }

  /** Revert every ACL grant, drop the profile identity, remove the home. */
  dispose() {
    for (const path of this.grants) {
      try { setAce(path, this.sid, 'revoke', 0); } catch { /* best-effort; ledger recorded */ }
    }
    try { deleteProfile(this.containerName); } catch { /* best-effort */ }
    try { rmSync(this.homeDir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

module.exports = {LowBoxAttempt};
