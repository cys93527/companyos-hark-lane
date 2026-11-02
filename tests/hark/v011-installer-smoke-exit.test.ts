import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * v0.1.1 CI (hark-installer 41484527302): every smoke check passed ("installer smoke: all checks
 * passed") but the step failed with exit 1. Root cause: the script ended without an explicit exit,
 * so the runner's pwsh wrapper took the leaked $LASTEXITCODE of the last native call — the AUDIT-S8
 * tamper probe, which is REQUIRED to fail (exit 3). The verdict is the check table: the script must
 * exit 1 on any failed check and exit 0 explicitly otherwise.
 */
const smoke = readFileSync('scripts/hark/installer-smoke.ps1', 'utf8');

describe('installer smoke exit code is the check verdict, never a leaked native exit code', () => {
  it('ends with an explicit exit 0 right after the all-passed line', () => {
    expect(smoke).toMatch(/Write-Host 'installer smoke: all checks passed'\r?\nexit 0\s*$/);
  });
  it('still exits 1 when any check failed', () => {
    expect(smoke).toContain('if ($failed.Count -gt 0) { Write-Host "FAILED: $(($failed | ForEach-Object Key) -join \', \')"; exit 1 }');
  });
});
