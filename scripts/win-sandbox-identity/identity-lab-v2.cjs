/**
 * STAGE 5D-B — Dedicated Sandbox Identity + Per-Attempt Restricting SID.
 *
 * Architecture (Boss §3):
 *   Install-level sandbox account (persistent, one password in LSA/memory)
 * + Per-attempt unique restricting SID (S-1-4-x synthetic)
 * + Windows Firewall outbound Block scoped to the ACCOUNT SID
 * + Job Object KILL_ON_JOB_CLOSE
 * + FFI SetEntriesInAclW with read-back verify on every grant/revoke
 *
 * The restricting SID makes every access check require BOTH the normal token
 * SID chain AND the restricting SID: files granted to Users/Authenticated
 * Users/Everyone but NOT to the restricting SID are DENIED (Boss §3-§4).
 *
 * Process creation goes through a PowerShell launcher (launcher.ps1) because
 * Git Bash→node strips SeImpersonatePrivilege; PS children hold it.
 */
const {execFileSync} = require('node:child_process');
const {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {randomBytes, createHash} = require('node:crypto');

const {setAceVerified} = require('../win-sandbox/aclffi.cjs');

const LAUNCHER_PS1 = join(__dirname, 'launcher.ps1');
const FIREWALL_RULE_NAME = 'CompanyOS Sandbox Identity Block';

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

class RestrictedSandboxAttempt {
  constructor(options) {
    this.timings = {};
    this.workspaceRoot = options.workspaceRoot;
    this.toolchainRoots = options.toolchainRoots ?? [];
    this.parent = options.parent; // RestrictedSandboxParent

    // Per-attempt restricting SID (S-1-4-x-y deterministic from random path)
    const attemptSalt = randomBytes(16).toString('hex');
    const digest = createHash('sha256').update(`companyos-attempt:${attemptSalt}`).digest();
    const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
    const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
    this.restrictingSid = `S-1-4-${first}-${second}`;

    this.homeDir = mkdtempSync(join(options.labRoot, 'home-'));

    const t0 = Date.now();
    // ACL: workspace + home get FULL for BOTH account SID and restricting SID.
    for (const [path, perms] of [
      [this.workspaceRoot, 'full'], [this.homeDir, 'full'],
      ...this.toolchainRoots.map((p) => [p, 'rx']),
    ]) {
      setAceVerified(path, this.parent.accountSid, 'grant', perms, this.parent.accountName);
      setAceVerified(path, this.restrictingSid, 'grant', perms, this.restrictingSid);
    }
    this.grants = [
      [this.workspaceRoot, 'full'], [this.homeDir, 'full'],
      ...this.toolchainRoots.map((p) => [p, 'rx']),
    ];
    this.timings.aclGrant = Date.now() - t0;
  }

  /** Launch one command in the restricted sandbox via the PS launcher. */
  run(options) {
    const {program, argv, cwd, env = {}, timeoutMs = 90_000, rawArgs = false} = options;
    const redirOut = join(this.workspaceRoot, `.sbx-out-${Date.now()}.txt`);
    const redirErr = join(this.workspaceRoot, `.sbx-err-${Date.now()}.txt`);
    const batch = join(this.workspaceRoot, `.sbx-cmd-${Date.now()}.cmd`);
    const q = (s) => `"${s}"`;
    const lines = [];
    for (const [key, value] of Object.entries(env)) lines.push(`@set "${key}=${value}"`);
    lines.push([q(program), ...(rawArgs ? argv : argv.map(quoteArg))].join(' ') + ` > ${q(redirOut)} 2> ${q(redirErr)}`);
    writeFileSync(batch, lines.join('\r\n') + '\r\n', 'utf8');

    const spec = {
      account: this.parent.accountName,
      password: this.parent.password,
      restrictingSid: this.restrictingSid,
      batch, cwd: cwd ?? this.workspaceRoot,
      stdoutFile: redirOut, stderrFile: redirErr,
      timeoutMs,
    };
    const specFile = join(this.workspaceRoot, `.sbx-spec-${Date.now()}.json`);
    writeFileSync(specFile, JSON.stringify(spec), 'utf8');

    const t0 = Date.now();
    let result;
    try {
      const output = execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER_PS1, '-SpecPath', specFile,
      ], {encoding: 'utf8', timeout: timeoutMs + 30_000, maxBuffer: 10 * 1024 * 1024});
      result = JSON.parse(output.trim().split('\n').pop());
    } catch (error) {
      const errOut = error.stderr ? String(error.stderr).slice(0, 500) : '';
      console.error('[launcher-err]', String(error.message).slice(0, 300), 'STDERR:', errOut);
      result = {exitCode: -1, pid: 0, timedOut: false, stdout: '', stderr: String(error.message).slice(0, 300) + ' PS_ERR: ' + errOut};
    }
    this.timings.launch = Date.now() - t0;
    try { rmSync(specFile, {force: true}); } catch { /* best-effort */ }
    return result;
  }

  /** Revoke ALL ACEs (account SID + restricting SID) with read-back verify. */
  dispose() {
    const t0 = Date.now();
    for (const [path] of this.grants) {
      setAceVerified(path, this.restrictingSid, 'revoke', 0, this.restrictingSid);
      setAceVerified(path, this.parent.accountSid, 'revoke', 0, this.parent.accountName);
    }
    this.timings.aclRevoke = Date.now() - t0;
    try { rmSync(this.homeDir, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

/** Install-level sandbox identity: one local account + one firewall rule. */
class RestrictedSandboxParent {
  constructor(options = {}) {
    this.timings = {};
    this.labRoot = options.labRoot ?? 'C:\\CompanyOS-SandboxLab';
    if (!existsSync(this.labRoot)) mkdirSync(this.labRoot, {recursive: true});
    // Harden the lab root: remove inherited Authenticated Users (Boss §2).
    this.#hardenLabRoot();

    this.accountName = options.accountName ?? `cos-sbx-${randomBytes(4).toString('hex')}`;
    this.password = randomBytes(24).toString('base64url') + '!A1';
    const t0 = Date.now();
    execFileSync('powershell', ['-NoProfile', '-Command',
      `$p = ConvertTo-SecureString '${this.password}' -AsPlainText -Force; New-LocalUser -Name '${this.accountName}' -Password $p -Description 'CompanyOS sandbox' -AccountNeverExpires -PasswordNeverExpires -ErrorAction SilentlyContinue | Out-Null`],
      {stdio: 'pipe', timeout: 60_000});
    this.accountSid = execFileSync('powershell', ['-NoProfile', '-Command',
      `(New-Object Security.Principal.NTAccount('${this.accountName}')).Translate([Security.Principal.SecurityIdentifier]).Value`],
      {encoding: 'utf8', timeout: 30_000}).trim();
    this.timings.accountCreate = Date.now() - t0;

    const t1 = Date.now();
    execFileSync('powershell', ['-NoProfile', '-Command',
      `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;${this.accountSid})" | Out-Null`],
      {stdio: 'pipe', timeout: 60_000});
    this.timings.firewallRule = Date.now() - t1;
  }

  #hardenLabRoot() {
    try {
      execFileSync('icacls', [this.labRoot, '/inheritance:r',
        '/grant', 'Administrators:(OI)(CI)F', '/grant', 'SYSTEM:(OI)(CI)F', '/grant', 'Administrator:(OI)(CI)F'],
        {stdio: 'pipe', timeout: 30_000});
    } catch { /* may already be hardened */ }
  }

  newAttempt(options) {
    return new RestrictedSandboxAttempt({
      parent: this,
      labRoot: this.labRoot,
      workspaceRoot: options.workspaceRoot,
      toolchainRoots: options.toolchainRoots ?? [],
    });
  }

  dispose() {
    const t0 = Date.now();
    try { execFileSync('powershell', ['-NoProfile', '-Command',
      `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}'`], {stdio: 'pipe', timeout: 60_000});
    } catch { /* best-effort */ }
    this.timings.firewallRemove = Date.now() - t0;
    const t1 = Date.now();
    try { execFileSync('powershell', ['-NoProfile', '-Command',
      `Remove-LocalUser -Name '${this.accountName}'`], {stdio: 'pipe', timeout: 60_000});
    } catch { /* best-effort */ }
    this.timings.accountDelete = Date.now() - t1;
    try { rmSync(this.labRoot, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
}

module.exports = {RestrictedSandboxParent, RestrictedSandboxAttempt, FIREWALL_RULE_NAME};
