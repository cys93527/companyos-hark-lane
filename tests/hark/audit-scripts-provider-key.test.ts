import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S9/D10: re-running 「CompanyOS 首次配置」 replaced model-api-key.dpapi BEFORE the app wrote/verified the rest,
 * and deleted it on any failure (or exited with Finish 5 when the app was missing): the user's previously working key
 * was lost. Now: app checked first, new blob -> .new, old -> .bak, swap, restore .bak on ANY failure, delete .bak only
 * after success; Invoke-SetupNode never exits the script.
 */
const ps1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'hark', 'setup', 'configure-deepseek.ps1'), 'utf8');
const fnBody = (name: string): string => {
  const m = new RegExp(`function ${name}[ (]`, 'u').exec(ps1);
  const start = m === null ? -1 : m.index;
  expect(start).toBeGreaterThanOrEqual(0);
  const end = ps1.indexOf('\n}\n', start);
  return ps1.slice(start, end);
};

describe('AUDIT-S9 configure-deepseek keeps the previous key on failure', () => {
  it('checks the app exists before asking for or writing any key', () => {
    const appCheck = ps1.indexOf('if (-not (Test-Path -LiteralPath $AppExe)) { Finish 5');
    expect(appCheck).toBeGreaterThan(0);
    expect(appCheck).toBeLessThan(ps1.indexOf('$secure = Read-Host -AsSecureString'));
    expect(appCheck).toBeLessThan(ps1.indexOf('$plain = [Console]::In.ReadLine()'));
    expect(appCheck).toBeLessThan(ps1.indexOf('WriteAllBytes('));
  });

  it('Invoke-SetupNode never terminates the script (so the caller can restore)', () => {
    const body = fnBody('Invoke-SetupNode');
    expect(body).not.toMatch(/\bFinish\b|\bexit\b(?! =)/u);
    expect(body).toContain('} catch {');
  });

  it('writes the new blob to .new, keeps the old key as .bak, and swaps', () => {
    expect(ps1).toContain('[IO.File]::WriteAllBytes($newKey, $blob)');
    expect(ps1).not.toMatch(/WriteAllBytes\(\$tmp|Move-Item -LiteralPath \$tmp/u);
    expect(ps1).toContain('if ($hadOld) { Move-Item -LiteralPath $keyFile -Destination $bakKey -Force }');
    expect(ps1).toContain('Move-Item -LiteralPath $newKey -Destination $keyFile -Force');
  });

  it('a failed write restores the previous key and only success deletes the backup', () => {
    // UI-AUDIT-2: the write arguments are built first (shipped profile or -Custom), then one call.
    const write = ps1.indexOf('$r = Invoke-SetupNode $writeArgs');
    expect(write).toBeGreaterThan(ps1.indexOf("$writeArgs = @('write',"));
    const after = ps1.slice(write);
    const failBlock = after.slice(after.indexOf('if ($r.exit -ne 0'), after.indexOf('Finish 3'));
    expect(failBlock).toContain('Restore-PreviousKey');
    expect(failBlock).not.toMatch(/Remove-Item -LiteralPath \$keyFile/u);
    const restore = fnBody('Restore-PreviousKey');
    expect(restore).toContain('Move-Item -LiteralPath $bakKey -Destination $keyFile -Force');
    const bakDelete = ps1.lastIndexOf('Remove-Item -LiteralPath $bakKey -Force -ErrorAction SilentlyContinue');
    expect(bakDelete).toBeGreaterThan(ps1.indexOf('Finish 3 "配置写入失败'));
  });

  it('a .bak left by an interrupted run is recovered, never silently dropped while no key exists', () => {
    expect(ps1).toContain('if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $bakKey -Force } else { Move-Item -LiteralPath $bakKey -Destination $keyFile -Force }');
  });
});
