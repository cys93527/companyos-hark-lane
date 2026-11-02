import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S5: setup.ps1 validated the reader SID only AFTER it had created the account, granted ACLs and the profile,
 * with a loose pattern (^S-1-5-21-[0-9-]+$) that also rejected Microsoft Entra ID sign-ins (S-1-12-1-...). The reader
 * SID is now parsed and checked (local/AD user S-1-5-21-a-b-c-d or Entra S-1-12-1-a-b-c-d) before any system change.
 */
const root = join(__dirname, '..', '..');
const setup = readFileSync(join(root, 'scripts', 'hark', 'isolation', 'setup.ps1'), 'utf8');
const lifecycle = readFileSync(join(root, 'scripts', 'hark', 'isolation', 'lifecycle.ps1'), 'utf8');

const local = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const entra = /^S-1-12-1-\d+-\d+-\d+-\d+$/;
const accepted = (sid: string): boolean => local.test(sid) || entra.test(sid);

describe('AUDIT-S5 reader SID validated before any change', () => {
  it('setup.ps1 carries exactly the two user-SID patterns', () => {
    expect(setup).toContain("$reader -notmatch '^S-1-5-21-\\d+-\\d+-\\d+-\\d+$' -and $reader -notmatch '^S-1-12-1-\\d+-\\d+-\\d+-\\d+$'");
    expect(setup).toContain('(New-Object Security.Principal.SecurityIdentifier($readerIn)).Value');
    expect(setup).not.toContain("'^S-1-5-21-[0-9-]+$'");
  });

  it('the check precedes every system change in install', () => {
    const install = setup.slice(setup.indexOf("'install' {"));
    const check = install.indexOf("error = 'READER_SID_INVALID'");
    expect(check).toBeGreaterThan(0);
    for (const change of ['New-LocalUser', 'Set-LocalUser', 'New-ItemProperty', 'Grant $d', '[CompanyOSProfile]::Create', '[CompanyOSWfp]::Install']) {
      expect(install.indexOf(change), change).toBeGreaterThan(check);
    }
    expect(setup.match(/READER_SID_INVALID/g)).toHaveLength(1);
  });

  it('accepts local/AD and Entra user SIDs, refuses groups and well-known SIDs', () => {
    expect(accepted('S-1-5-21-1111111111-2222222222-3333333333-1001')).toBe(true);
    expect(accepted('S-1-12-1-1234567890-1234567890-1234567890-1234567890')).toBe(true);
    for (const bad of ['S-1-5-32-544', 'S-1-5-18', 'S-1-1-0', 'S-1-5-21-1-2', 'S-1-5-21-1-2-3-4-5', 'S-1-12-1-1-2-3', 'S-1-5-21-1--2-3-4']) {
      expect(accepted(bad), bad).toBe(false);
    }
  });

  it('the CI lifecycle asserts the Administrators SID is refused with nothing created', () => {
    expect(lifecycle).toContain("ReaderSid = 'S-1-5-32-544'");
    expect(lifecycle).toContain("Check 'L0.readerSid.groupRejected'");
    expect(lifecycle).toContain("Check 'L0.readerSid.noAccountNoState'");
    expect(lifecycle).toContain('$report.checks.Count -lt 45');
  });
});
