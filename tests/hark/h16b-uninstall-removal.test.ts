import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * H16b-3b-fix4 (hark-installer 41191287370, 41194007074): the uninstaller's hidden
 * 'configure-isolation.ps1 -Remove -IfConfigured -NoPause' exited 3 with NO helper output, leaving the agent account,
 * state and credential behind, while the very same helper run directly removed everything. Inno 6.7 RedirectionGuard
 * is inherited by every child of a PrivilegesRequired=lowest Setup/Uninstall; it is off for this per-user installer.
 * An already-elevated caller runs the helper directly with its output and exit code captured; every outcome is logged.
 */
const root = join(__dirname, '..', '..');
const iss = readFileSync(join(root, 'installer', 'companyos.iss'), 'utf8');
const configure = readFileSync(join(root, 'scripts', 'hark', 'setup', 'configure-isolation.ps1'), 'utf8');
const smoke = readFileSync(join(root, 'scripts', 'hark', 'installer-smoke.ps1'), 'utf8');

describe('H16b isolation removal on uninstall', () => {
  it('per-user installer turns RedirectionGuard off (inherited by [UninstallRun] children otherwise)', () => {
    expect(iss).toMatch(/^PrivilegesRequired=lowest\r?$/m);
    expect(iss).toMatch(/^RedirectionGuard=no\r?$/m);
    expect(iss).toMatch(/configure-isolation\.ps1""\s+-Remove -IfConfigured -NoPause/);
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
