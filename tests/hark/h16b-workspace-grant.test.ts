import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * H16b-3b-fix2 (hark-installer 41184110972): the kernel's inner shell sandbox (upstream sandbox-windows-acl grantWrite)
 * edits the goal workspace's DACL and mandatory label AS the isolated agent account, which needs WRITE_DAC and
 * WRITE_OWNER there. setup.ps1 must grant the workspace roots FullControl (inherited); the kernel state dirs stay Modify
 * and the kernel dirs ReadAndExecute — the agent never gets more than that outside the workspace.
 */
const setup = readFileSync(join(__dirname, '..', '..', 'scripts', 'hark', 'isolation', 'setup.ps1'), 'utf8');

describe('H16b isolation setup grants', () => {
  it('grants FullControl (inherited) on workspace roots only', () => {
    expect(setup).toMatch(/foreach \(\$d in \$WorkspaceDirs\) \{[^}]*Grant \$d \$sid 'FullControl' 'Allow' \$true \$grants \}/);
    expect(setup).toMatch(/foreach \(\$d in \$StateDirs\) \{[^}]*Grant \$d \$sid 'Modify' 'Allow' \$true \$grants \}/);
    expect(setup).toMatch(/foreach \(\$d in \$KernelDirs\) \{ Grant \$d \$sid 'ReadAndExecute' 'Allow' \$true \$grants \}/);
    const fullControl = setup.match(/'FullControl' 'Allow'/g) ?? [];
    expect(fullControl).toHaveLength(1);
  });

  it('the lifecycle tamper check expects the workspace grant it removes', () => {
    const lifecycle = readFileSync(join(__dirname, '..', '..', 'scripts', 'hark', 'isolation', 'lifecycle.ps1'), 'utf8');
    expect(lifecycle).toContain("'^acl:missing:Allow:FullControl'");
  });
});
