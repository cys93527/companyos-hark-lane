import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error -- plain ESM script without types
import { main } from '../../scripts/hark/setup/configure-provider.mjs';

/*
 * AUDIT-S13: a failed setup write showed an empty error: the app-module import ran outside the try (stdout empty) and
 * configure-deepseek.ps1 deleted node's stderr unread (and ConvertFrom-Json on an empty stdout threw).
 */
const ps1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'hark', 'setup', 'configure-deepseek.ps1'), 'utf8');

describe('AUDIT-S13 setup failures carry their reason', () => {
  it('a missing app module answers with a JSON error and exit 3', async () => {
    const lines: string[] = [];
    const empty = mkdtempSync(join(tmpdir(), 'audit-s13-'));
    const code = await (main as (argv: string[], log: (l: string) => void) => Promise<number>)(
      ['write', '--user-data', empty, '--cap-cny', '1', '--approved-by', 'alice', '--dist', empty],
      (l) => lines.push(l),
    );
    expect(code).toBe(3);
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]!) as { ok: boolean; code: string; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toContain('provider-setup-write.js');
  });

  it('configure-deepseek appends trimmed, capped node stderr to the shown message', () => {
    expect(ps1).toContain('$errText = ([IO.File]::ReadAllText($err, (New-Object Text.UTF8Encoding($false)))).Trim()');
    expect(ps1).toContain("if ($errText.Length -gt 2000) { $errText = $errText.Substring(0, 2000) + ' ...' }");
    expect(ps1).toContain('if ($errText) { $raw = ($raw + [Environment]::NewLine + $errText).Trim() }');
    expect(ps1).toContain('return [pscustomobject]@{ exit = $p.ExitCode; result = $parsed; raw = $raw }');
    expect(ps1).toContain('if (-not [string]::IsNullOrWhiteSpace($text)) { try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null } }');
  });
});
