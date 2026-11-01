import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S2: Windows PowerShell 5.1 Get-Content decodes a BOM-less file with the ANSI code page (CP936 on zh-CN).
 * The app writes workspace-selection.json as BOM-less UTF-8 (workspace-selection.ts), so a Chinese workspace path
 * came back as mojibake and isolation setup always said 「请先打开 CompanyOS 选择工作区」. Every JSON/state read in the
 * shipped 5.1 scripts must name its encoding explicitly.
 */
const root = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/^\uFEFF/, '');
const configureIsolation = read('scripts/hark/setup/configure-isolation.ps1');
const setup = read('scripts/hark/isolation/setup.ps1');

describe('AUDIT-S2 explicit UTF-8 reads in 5.1 scripts', () => {
  it('configure-isolation reads workspace-selection.json as BOM-less UTF-8', () => {
    expect(configureIsolation).toMatch(
      /\[IO\.File\]::ReadAllText\(\$sel, \(New-Object Text\.UTF8Encoding\(\$false\)\)\) \| ConvertFrom-Json\)\.root/,
    );
    expect(configureIsolation).not.toMatch(/Get-Content -LiteralPath \$sel/);
  });

  it('setup.ps1 reads state.json and wfp-persistent.cs with -Encoding UTF8', () => {
    const stateReads = setup.match(/Get-Content -LiteralPath \$StatePath[^|\r\n]*/g) ?? [];
    expect(stateReads.length).toBeGreaterThanOrEqual(3);
    for (const r of stateReads) expect(r).toContain('-Encoding UTF8');
    expect(setup).toMatch(/Get-Content -LiteralPath \(Join-Path \$PSScriptRoot 'wfp-persistent\.cs'\) -Raw -Encoding UTF8/);
  });
});
