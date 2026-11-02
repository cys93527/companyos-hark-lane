import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S8: configure-isolation.ps1 elevated (UAC) and then executed setup.ps1 / wfp-persistent.cs in place from the
 * per-user, user-writable install directory, so a standard user (or malware) could edit them and the next
 * administrator approval ran that code as administrator. Every elevated run now goes through one stub that copies the
 * helper into a fresh Administrators+SYSTEM-only %ProgramData% directory, verifies each file's SHA-256 against the
 * build-time manifest (stage-desktop.mjs) on the very bytes it writes, runs from there and deletes the directory.
 * Windows proof: hark-installer install-smoke check h16-helper-tamper-refused.
 */
const root = join(__dirname, '..', '..');
const cfg = readFileSync(join(root, 'scripts', 'hark', 'setup', 'configure-isolation.ps1'), 'utf8');
const stage = readFileSync(join(root, 'scripts', 'hark', 'stage-desktop.mjs'), 'utf8');
const smoke = readFileSync(join(root, 'scripts', 'hark', 'installer-smoke.ps1'), 'utf8');
const stub = cfg.slice(cfg.indexOf("$ELEVATED_STUB = @'"), cfg.indexOf("'@", cfg.indexOf("$ELEVATED_STUB = @'")));
const invoke = cfg.slice(cfg.indexOf('function Invoke-Elevated($named) {'), cfg.indexOf('if (-not (Test-Path -LiteralPath $helper)'));

describe('AUDIT-S8 the elevated helper never runs user-writable bytes', () => {
  it('neither elevation path executes the helper from the install directory', () => {
    expect(invoke).not.toContain("'-File', $helper");
    expect(invoke).not.toMatch(/-File \$helper/);
    expect(invoke.match(/New-ElevatedBootstrap \$named/g)?.length).toBe(2);
    expect(invoke).toContain("-Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $boot.command)");
  });

  it('the stub creates an Administrators+SYSTEM-only directory atomically and verifies the bytes it writes', () => {
    expect(stub).toContain("Join-Path $env:ProgramData ('CompanyOS-isolation-helper-' + [Guid]::NewGuid().ToString('N'))");
    expect(stub).toContain('$sec.SetAccessRuleProtection($true, $false)');
    expect(stub).toContain("foreach ($s in @('S-1-5-32-544', 'S-1-5-18'))");
    expect(stub).toContain('[void][IO.Directory]::CreateDirectory($dir, $sec)');
    const read = stub.indexOf('$bytes = [IO.File]::ReadAllBytes((Join-Path $src $name))');
    const check = stub.indexOf("if ($hash -ne $expected[$name]) { $mismatch = $name; break }");
    const write = stub.indexOf('$fs.Write($bytes, 0, $bytes.Length)');
    const run = stub.indexOf("-File (Join-Path $dir 'setup.ps1') @helperArgs");
    expect(read).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(check);
    expect(run).toBeGreaterThan(write);
    expect(stub).toContain('[IO.FileMode]::CreateNew');
    expect(stub).toContain('"error":"HELPER_HASH_MISMATCH"');
    expect(stub).toContain('Remove-Item -LiteralPath $dir -Recurse -Force');
  });

  it('the bootstrap pins the stub hash, runs the verified bytes from memory and has no double quotes', () => {
    const boot = cfg.slice(cfg.indexOf("$boot = '$b = [IO.File]::ReadAllBytes("), cfg.indexOf("return [pscustomobject]@{ command = $boot"));
    expect(boot).toContain("{ exit 7 }");
    expect(boot).toContain('& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($b)))');
    expect(boot).not.toContain('"');
  });

  it('stage-desktop pins the helper hashes and the configure script refuses to run without them', () => {
    expect(stage).toContain("writeFileSync(join(out, 'resources', 'isolation', 'helper-sha256.json')");
    expect(stage).toContain("for (const name of ['setup.ps1', 'wfp-persistent.cs'])");
    expect(cfg).toContain("if ($null -eq (Get-HelperHashes)) { Finish 5");
  });

  it('the installed-app smoke proves a tampered helper is refused', () => {
    expect(smoke).toContain("Check 'h16-helper-tamper-refused'");
    expect(smoke).toContain('[IO.File]::WriteAllBytes($isoSetup, $isoSetupBytes)');
  });
});
