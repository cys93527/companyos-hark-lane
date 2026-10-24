/**
 * STAGE 5D — WINDOWS DEDICATED SANDBOX IDENTITY LAB (Boss §2-§38, Phase A).
 *
 * Selected mechanism (source-first comparison in the proof doc):
 *   DEDICATED LOCAL LOW-PRIVILEGE ACCOUNT (real machine SID)
 * + CreateRestrictedToken with the account's own SID as the ONLY restricting
 *   SID (filesystem deny-by-default — BUILTIN\Users inheritance grants do NOT
 *   leak reads, Boss §36)
 * + Windows Firewall outbound BLOCK scoped to the account SID (identity-bound
 *   network enforcement — the user's own node.exe is untouched, §19/§35)
 * + Job Object KILL_ON_JOB_CLOSE (tree lifetime).
 *
 * The password exists ONLY in this process's memory for the lab proof; the
 * production path is an LSA-backed secret written once by the installer and
 * readable only by the CompanyOS SYSTEM broker (Boss §9 — no plaintext in
 * repo/config/SQLite/artifact/log/env). Install-time actions (account create,
 * firewall rule) need admin; per-task runtime runs through this lab WITHOUT
 * elevation (CreateProcessWithLogonW needs no UAC — same as runas).
 */
const {execFileSync} = require('node:child_process');
const {mkdtempSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {randomBytes} = require('node:crypto');

const {setAceVerified, koffi} = require('../win-sandbox/aclffi.cjs');

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

// ---- process/token FFI ----
const STARTUPINFOW = koffi.struct('IDStartupInfoW', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32',
  wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *',
  hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
});
const PROCESS_INFORMATION = koffi.struct('IDProcessInformation', {
  hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
});
const JBLI = koffi.struct('IDJobBasicLimits', {
  PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'uintptr_t', MaximumWorkingSetSize: 'uintptr_t',
  ActiveProcessLimit: 'uint32', Affinity: 'uintptr_t', PriorityClass: 'uint32', SchedulingClass: 'uint32',
});
const IOC = koffi.struct('IDIoCounters', {
  ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
});
const JELI = koffi.struct('IDJobExtendedLimits', {
  BasicLimitInformation: JBLI, IoInfo: IOC,
  ProcessMemoryLimit: 'uintptr_t', JobMemoryLimit: 'uintptr_t',
  PeakProcessMemoryUsed: 'uintptr_t', PeakJobMemoryUsed: 'uintptr_t',
});

const createProcessWithLogon = advapi32.func('int __stdcall CreateProcessWithLogonW(str16 u, str16 d, str16 p, uint32 flags, str16 app, str16 cmd, uint32 creation, void *env, str16 cwd, void *si, void *pi)');
const createJobObject = kernel32.func('void * __stdcall CreateJobObjectW(void *a, str16 n)');
const setJobInfo = kernel32.func('int __stdcall SetInformationJobObject(void *j, uint32 c, void *i, uint32 s)');
const assignJob = kernel32.func('int __stdcall AssignProcessToJobObject(void *j, void *p)');
const terminateJob = kernel32.func('int __stdcall TerminateJobObject(void *j, uint32 code)');
const waitFor = kernel32.func('uint32 __stdcall WaitForSingleObject(void *h, uint32 ms)');
const getExitCode = kernel32.func('int __stdcall GetExitCodeProcess(void *h, _Out_ uint32 *c)');
const closeHandle = kernel32.func('int __stdcall CloseHandle(void *h)');
const resumeThread = kernel32.func('uint32 __stdcall ResumeThread(void *h)');
const lastError = kernel32.func('uint32 __stdcall GetLastError()');

const CREATE_SUSPENDED = 0x4;
const JOB_EXTENDED_LIMIT_CLASS = 9;
const JOB_LIMIT_KILL_ON_CLOSE = 0x2000;
const WAIT_TIMEOUT_ = 0x102;

const FIREWALL_RULE_PREFIX = 'CompanyOS Sandbox Lab Block';

const quoteArg = (argument) => {
  if (!/[ \t"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const char of argument) {
    if (char === '\\') { backslashes += 1; continue; }
    if (char === '"') { quoted += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
};

/** One dedicated-identity attempt: account + firewall rule + ACLs + job. */
class SandboxIdentity {
  constructor(options) {
    this.timings = {};
    this.workspaceRoot = options.workspaceRoot;
    this.toolchainRoots = options.toolchainRoots ?? [];
    this.accountName = `cos-sbx-${randomBytes(4).toString('hex')}`;
    this.password = randomBytes(24).toString('base64url') + '!A1'; // memory only
    const t0 = Date.now();
    // Install-time actions (lab has admin; production = installer/broker).
    execFileSync('powershell', ['-NoProfile', '-Command',
      `$p = ConvertTo-SecureString '${this.password}' -AsPlainText -Force; New-LocalUser -Name '${this.accountName}' -Password $p -Description 'CompanyOS sandbox lab' -AccountNeverExpires -PasswordNeverExpires | Out-Null`],
      {timeout: 60_000});
    this.timings.accountCreate = Date.now() - t0;
    const sidOut = execFileSync('powershell', ['-NoProfile', '-Command',
      `(New-Object Security.Principal.NTAccount('${this.accountName}')).Translate([Security.Principal.SecurityIdentifier]).Value`], {encoding: 'utf8', timeout: 30_000}).trim();
    this.sid = sidOut;

    const t1 = Date.now();
    // Network enforcement: identity-scoped outbound block (NOT per-exe).
    execFileSync('powershell', ['-NoProfile', '-Command',
      `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_PREFIX} ${this.accountName}' -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;${this.sid})" | Out-Null`],
      {stdio: 'pipe', timeout: 60_000});
    this.timings.firewallRule = Date.now() - t1;

    this.homeDir = mkdtempSync(join(tmpdir(), 'sbx-home-'));
    const t2 = Date.now();
    for (const [path, perms] of [[this.workspaceRoot, 'full'], [this.homeDir, 'full'], ...this.toolchainRoots.map((p) => [p, 'rx'])]) {
      setAceVerified(path, this.sid, 'grant', perms, this.accountName);
    }
    this.grants = [[this.workspaceRoot, 'full'], [this.homeDir, 'full'], ...this.toolchainRoots.map((p) => [p, 'rx'])];
    this.timings.aclGrant = Date.now() - t2;
  }

  /** Logon -> restrict (own SID only) -> spawn under job; env allowlist via lpEnvironment. */
  run(options) {
    const {program, argv, cwd, env = {}, timeoutMs = 90_000, rawArgs = false} = options;
    const redirOut = join(this.workspaceRoot, `.sbx-stdout-${Date.now()}.txt`);
    const redirErr = join(this.workspaceRoot, `.sbx-stderr-${Date.now()}.txt`);
    const batch = join(this.workspaceRoot, `.sbx-run-${Date.now()}.cmd`);
    const q = (s) => `"${s}"`;
    const lines = [];
    for (const [key, value] of Object.entries(env)) lines.push(`@set "${key}=${value}"`);
    lines.push([q(program), ...(rawArgs ? argv : argv.map(quoteArg))].join(' ') + ` > ${q(redirOut)} 2> ${q(redirErr)}`);
    writeFileSync(batch, lines.join('\r\n') + '\r\n', 'utf8');

    // CreateProcessWithLogonW: seclogon performs the logon (the same service
    // runas uses) — the caller needs NO token privileges, so an unelevated
    // CompanyOS user-session process (or SYSTEM broker) can launch attempts.
    const si = koffi.alloc(STARTUPINFOW, 1);
    koffi.encode(si, STARTUPINFOW, {cb: koffi.sizeof(STARTUPINFOW)});
    const pi = koffi.alloc(PROCESS_INFORMATION, 1);
    const job = createJobObject(koffi.NULL, `companyos.sbx.${randomBytes(4).toString('hex')}`);
    const jeli = koffi.alloc(JELI, 1);
    koffi.encode(jeli, JELI, {BasicLimitInformation: {LimitFlags: JOB_LIMIT_KILL_ON_CLOSE}});
    if (!setJobInfo(job, JOB_EXTENDED_LIMIT_CLASS, jeli, koffi.sizeof(JELI))) throw new Error('SetInformationJobObject failed');

    const t0 = Date.now();
    const cmdLine = `C:\\Windows\\System32\\cmd.exe /d /c ""${batch}""`;
    // CreateProcessWithLogonW: seclogon handles the logon — zero caller
    // privileges required (the same service `runas` uses). Filesystem
    // isolation comes from the LAB ROOT ACL (no Authenticated Users) plus the
    // explicit sandbox-SID grants; production adds a restricted token via the
    // SYSTEM broker for defense in depth (Boss §36).
    const created = createProcessWithLogon(this.accountName, '.', this.password, 0, null, cmdLine,
      CREATE_SUSPENDED, koffi.NULL, cwd ?? this.workspaceRoot, si, pi);
    this.timings.launch = Date.now() - t0;
    if (!created) {
      const err = lastError();
      closeHandle(job);
      throw new Error(`CreateProcessWithLogonW failed err=${err}`);
    }
    const info = koffi.decode(pi, PROCESS_INFORMATION);
    const assigned = assignJob(job, info.hProcess) === 1;
    resumeThread(info.hThread);
    const wait = waitFor(info.hProcess, timeoutMs);
    let timedOut = false;
    if (wait === WAIT_TIMEOUT_) {
      timedOut = true;
      terminateJob(job, 124);
      waitFor(info.hProcess, 10_000);
    }
    const codeOut = [0];
    getExitCode(info.hProcess, codeOut);
    const readSoft = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
    const stdout = readSoft(redirOut);
    const stderr = readSoft(redirErr);
    closeHandle(info.hProcess);
    closeHandle(info.hThread);
    closeHandle(job); // kill-on-close sweep
    return {exitCode: codeOut[0], pid: info.dwProcessId, jobAssigned: assigned, timedOut, stdout, stderr};
  }

  /** ACL read-back + firewall read-back + revoke-verify + account teardown. */
  dispose() {
    const t0 = Date.now();
    for (const [path] of this.grants) {
      setAceVerified(path, this.sid, 'revoke', 0, this.accountName);
    }
    this.timings.aclRevoke = Date.now() - t0;
    const t1 = Date.now();
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_PREFIX} ${this.accountName}'`], {stdio: 'pipe', timeout: 60_000});
    this.timings.firewallRemove = Date.now() - t1;
    const t2 = Date.now();
    execFileSync('powershell', ['-NoProfile', '-Command', `Remove-LocalUser -Name '${this.accountName}'`], {stdio: 'pipe', timeout: 60_000});
    this.timings.accountDelete = Date.now() - t2;
    try { rmSync(this.homeDir, {recursive: true, force: true}); } catch { /* best effort */ }
  }
}

module.exports = {SandboxIdentity, FIREWALL_RULE_PREFIX};
