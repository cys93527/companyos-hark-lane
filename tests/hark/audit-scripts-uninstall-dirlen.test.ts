import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S7: the isolation removal was an [UninstallRun] entry; Inno ignores its exit code, so a failed or refused (UAC)
 * removal still deleted the app and the only removal tool, orphaning the hidden agent account. It now runs in
 * InitializeUninstall (before anything is deleted) and a failure offers Abort/Retry/Ignore (silent default Abort).
 * AUDIT-S11: the MAX_PATH install-dir guard lived only in NextButtonClick (the dir page), which silent /DIR= installs
 * skip; PrepareToInstall now applies the same rule (exit 7, nothing written).
 */
const root = join(__dirname, '..', '..');
const iss = readFileSync(join(root, 'installer', 'companyos.iss'), 'utf8');
const smoke = readFileSync(join(root, 'scripts', 'hark', 'installer-smoke.ps1'), 'utf8');
const code = iss.slice(iss.indexOf('[Code]'));

describe('AUDIT-S7 uninstall never ignores a failed isolation removal', () => {
  it('no [UninstallRun] section; InitializeUninstall runs the helper and checks its exit code', () => {
    expect(iss).not.toMatch(/^\[UninstallRun\]/m);
    const fn = code.slice(code.indexOf('function InitializeUninstall(): Boolean;'));
    expect(fn).toContain("Exec(Ps, Params, '', SW_HIDE, ewWaitUntilTerminated, Code)");
    expect(fn).toContain('if Code = 0 then');
    expect(fn).toContain("SuppressibleMsgBox(FmtMessage(CustomMessage('IsolationRemoveFailed'), [IntToStr(Code)]), mbError, MB_ABORTRETRYIGNORE, IDABORT)");
    expect(fn).toMatch(/else if Choice <> IDRETRY then\s+begin\s+Result := False;/);
    expect(iss).toMatch(/^chs\.IsolationRemoveFailed=.*%1/m);
  });
});

describe('AUDIT-S11 MAX_PATH guard also for silent installs', () => {
  it('one shared rule used by the dir page and PrepareToInstall', () => {
    expect(code).toContain('function InstallDirTooLongMessage(Dir: String): String;');
    expect(code).toMatch(/function NextButtonClick[\s\S]*?InstallDirTooLongMessage\(WizardDirValue\)/);
    expect(code).toMatch(/function PrepareToInstall\(var NeedsRestart: Boolean\): String;\s+begin\s+Result := InstallDirTooLongMessage\(ExpandConstant\('\{app\}'\)\);/);
    expect(code.match(/Limit := 259 - \{#MaxRelPath\} - 1;/g)).toHaveLength(1);
  });
  it('the installer smoke asserts a silent too-long /DIR exits 7 and writes nothing', () => {
    expect(smoke).toContain("Check 's11-silent-toolong-refused' (($pl.ExitCode -eq 7) -and (-not $longLeft))");
    expect(smoke.indexOf('s11-silent-toolong-refused')).toBeLessThan(smoke.indexOf("Check 'install-exit-0'"));
  });
});
