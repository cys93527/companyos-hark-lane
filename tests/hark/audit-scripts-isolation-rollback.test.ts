import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S4: a failed isolation install left an enabled hidden local account, ACEs, a profile and WFP objects with no
 * state file (written only at the very end), so nothing could ever remove them and each retry minted another orphan.
 * AUDIT-S6: uninstall deleted state.json unconditionally, even when the profile (hive loaded by a running goal), an ACE
 * or the account was left, so a retry / the uninstaller reported NOT_CONFIGURED and the leftovers were orphaned.
 * Behaviour is proved on Windows by hark-isolation lifecycle checks L0b (forced failure -> full rollback) and L8a
 * (forced partial removal -> state kept, DEGRADED, retry finishes); this test pins the structure the lifecycle relies on.
 */
const root = join(__dirname, '..', '..');
const setup = readFileSync(join(root, 'scripts', 'hark', 'isolation', 'setup.ps1'), 'utf8');
const lifecycle = readFileSync(join(root, 'scripts', 'hark', 'isolation', 'lifecycle.ps1'), 'utf8');
const install = setup.slice(setup.indexOf("'install' {"), setup.indexOf("'uninstall' {"));
const removal = setup.slice(setup.indexOf('function Invoke-Removal($st) {'), setup.indexOf('switch ($Action) {'));

describe('AUDIT-S4 install is all-or-nothing', () => {
  it('validates storage and the account before the first system change', () => {
    const firstChange = install.indexOf('New-LocalUser');
    for (const check of ["error = 'DIR_NOT_ACL_CAPABLE'", "error = 'KERNEL_DIR_MISSING'", "error = 'ACCOUNT_NOT_COMPANYOS'", "error = 'READER_SID_INVALID'"]) {
      const at = install.indexOf(check);
      expect(at, check).toBeGreaterThan(0);
      expect(at, check).toBeLessThan(firstChange);
    }
    expect(setup).toMatch(/if \(\$fmt -ne 'NTFS' -and \$fmt -ne 'ReFS'\) \{ return \$false \}/);
  });

  it('writes a provisional state right after the account exists and before any grant', () => {
    expect(install).toContain("schema = $SCHEMA; phase = 'installing'");
    const sidKnown = install.indexOf('$state.sid = $sid');
    const firstSave = install.indexOf('Save-State $state', sidKnown);
    expect(sidKnown).toBeGreaterThan(0);
    expect(firstSave).toBeGreaterThan(sidKnown);
    expect(firstSave).toBeLessThan(install.indexOf('New-ItemProperty -Path $HIDE_KEY'));
    expect(firstSave).toBeLessThan(install.indexOf("Grant $d $sid 'FullControl'"));
    expect(install.indexOf("$state.phase = 'installed'")).toBeGreaterThan(install.indexOf('[CompanyOSWfp]::Install('));
  });

  it('every failure inside the change section rolls back through the shared removal routine', () => {
    const tryAt = install.indexOf('    try {\n');
    const catchAt = install.indexOf('    } catch {');
    expect(tryAt).toBeGreaterThan(0);
    expect(tryAt).toBeLessThan(install.indexOf('New-LocalUser'));
    expect(catchAt).toBeGreaterThan(install.indexOf("$state.phase = 'installed'"));
    const section = install.slice(tryAt, catchAt);
    expect(section).not.toContain('Out-Result');
    expect(install.slice(catchAt)).toContain('try { $rolledBack = Invoke-Removal $state } catch {');
    expect(section).toContain("throw ('PROFILE_CREATE_FAILED 0x{0:x8}' -f $hr)");
    expect(section).toContain("throw 'PROFILE_NOT_REGISTERED'");
    expect(section).toContain("throw ('WFP_INSTALL_FAILED 0x{0:x}' -f $rc)");
  });

  it('status never reports an incomplete state as ISOLATED', () => {
    expect(setup).toContain("if ($st.phase -and $st.phase -ne 'installed') { $problems.Add(\"state:incomplete:$($st.phase)\") | Out-Null }");
  });
});

describe('AUDIT-S6 removal keeps its state until everything is gone', () => {
  it('stops agent processes before touching the profile, retries the profile delete, guards the account', () => {
    expect(removal.indexOf('Stop-AgentProcesses $st.sid')).toBeLessThan(removal.indexOf('[CompanyOSProfile]::Delete('));
    expect(removal).toContain('for ($i = 0; $i -lt 5; $i++) {');
    expect(removal).toContain('if ($user -and $user.Description -eq $AGENT_DESCRIPTION) {');
  });

  it('deletes the state file only when clean, otherwise rewrites it with phase=removing', () => {
    expect(removal).toContain('if ($clean) { Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue }');
    expect(removal).toContain("else { Set-Phase $st 'removing'; Save-State $st; $r.stateKept = $true }");
    const uninstall = setup.slice(setup.indexOf("'uninstall' {"));
    expect(uninstall).toContain('$r = Invoke-Removal $st');
    expect(uninstall).not.toContain('Remove-Item -LiteralPath $StatePath');
  });

  it('the Windows lifecycle proves rollback and partial removal', () => {
    expect(lifecycle).toContain("TestFailAt = 'afterProfile'");
    expect(lifecycle).toContain("Check 'L0b.rollback.noAccountNoState'");
    expect(lifecycle).toContain("TestFailAt = 'removalProfile'");
    expect(lifecycle).toContain("Check 'L8a.partial.stateKept'");
    expect(lifecycle).toContain("Check 'L8a.partial.statusDegraded'");
    expect(lifecycle).toContain('$report.checks.Count -lt 52');
  });
});
