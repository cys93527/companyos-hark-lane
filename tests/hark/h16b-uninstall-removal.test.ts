import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * H16b-3b-fix4 (hark-installer 41191287370, 41194007074): the uninstaller's hidden
 * 'configure-isolation.ps1 -Remove -IfConfigured -NoPause' exited 3 with NO helper output, leaving the agent account,
 * state and credential behind, while the very same helper run directly removed everything. Once the output was
 * captured (hark-installer 41195872992) the real cause showed: the uninstaller, started from a PowerShell 7 session,
 * passed pwsh's PSModulePath to Windows PowerShell 5.1, which then failed to autoload Microsoft.PowerShell.Security
 * ('Get-Acl ... module could not be loaded') and, for the earlier '*> file' redirection, Microsoft.PowerShell.Utility
 * (hence no output at all). The RedirectionGuard theory of 8817dec was wrong; the default is restored.
 * Every shipped Windows PowerShell script repairs PSModulePath first; an already-elevated caller runs the helper
 * directly with its output and exit code captured; every outcome is logged.
 */
const root = join(__dirname, '..', '..');
const iss = readFileSync(join(root, 'installer', 'companyos.iss'), 'utf8');
const configure = readFileSync(join(root, 'scripts', 'hark', 'setup', 'configure-isolation.ps1'), 'utf8');
const smoke = readFileSync(join(root, 'scripts', 'hark', 'installer-smoke.ps1'), 'utf8');
const shipped51 = [
  ['scripts', 'hark', 'setup', 'configure-isolation.ps1'],
  ['scripts', 'hark', 'setup', 'configure-deepseek.ps1'],
  ['scripts', 'hark', 'isolation', 'setup.ps1'],
].map((p) => ({ name: p.join('/'), text: readFileSync(join(root, ...p), 'utf8') }));

describe('H16b isolation removal on uninstall', () => {
  it('the uninstaller removes a configured isolation; Inno RedirectionGuard keeps its default', () => {
    expect(iss).toMatch(/^PrivilegesRequired=lowest\r?$/m);
    expect(iss).not.toMatch(/^RedirectionGuard=/m);
    expect(iss).toMatch(/configure-isolation\.ps1""\s+-Remove -IfConfigured -NoPause/);
  });
  it.each(shipped51)('$name repairs PSModulePath before its first command (5.1 under a pwsh parent)', ({ text }) => {
    const body = text.slice(text.search(/^\)\r?$/m));
    const call = body.search(/^Repair-WindowsPowerShellModulePath\r?$/m);
    expect(call).toBeGreaterThan(0);
    expect(body.slice(0, call).replace(/^#.*$/gm, '')).not.toMatch(/^\$ErrorActionPreference|^\s*&|Get-|Set-|New-Item/m);
    expect(text).toContain("if ($PSVersionTable.PSEdition -eq 'Core') { return }");
    expect(text).toContain("-notmatch '(^|\\\\)PowerShell(\\\\|$)'");
    expect(text).toContain("'WindowsPowerShell', 'v1.0', 'Modules'");
  });
  it('an elevated caller runs the helper directly, capturing stdout+stderr and the exit code', () => {
    expect(configure).toMatch(/if \(Test-Elevated\) \{[\s\S]*?& \$ps @args2 2>&1 \| Out-String; \$code = \$LASTEXITCODE/);
    expect(configure).toContain('退出码 $($r.exit)');
  });
  it('every outcome is appended to %APPDATA%\\CompanyOS\\isolation-setup.log and the smoke keeps it', () => {
    expect(configure).toContain("Join-Path $UserData 'isolation-setup.log'");
    expect(configure).toMatch(/AppendAllText\(\$setupLog/);
    expect(smoke).toContain('h16-isolation-setup-log.txt');
    expect(smoke).toMatch(/stateLeft=\$isoStateLeft credLeft=\$isoCredLeft accountLeft=\$isoAccountLeft/);
  });
});
