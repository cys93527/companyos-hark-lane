import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { interpretIsolationStatus, isolationDispatchDecision } from '../../apps/desktop/src/executor/isolation/isolation-status.js';

/*
 * AUDIT-S3: the app runs `setup.ps1 -Action status` hidden (OEM output code page 936/437) and decodes stdout as UTF-8.
 * 5.1 ConvertTo-Json does not escape non-ASCII, so a Chinese workspace root arrived as U+FFFD and every goal was refused
 * with workspace:notGranted. setup.ps1 now sets a UTF-8 output encoding AND emits ASCII-only JSON (\uXXXX above 0x7E).
 */
const root = join(__dirname, '..', '..');
const setup = readFileSync(join(root, 'scripts', 'hark', 'isolation', 'setup.ps1'), 'utf8');
const smoke = readFileSync(join(root, 'scripts', 'hark', 'installer-smoke.ps1'), 'utf8');

/** Same rule as setup.ps1 ConvertTo-AsciiJson: every UTF-16 unit above 0x7E becomes \uXXXX (lowercase hex). */
const asciiJson = (json: string): string =>
  Array.from({ length: json.length }, (_, i) => json.charCodeAt(i))
    .map((c) => (c > 0x7e ? `\\u${c.toString(16).padStart(4, '0')}` : String.fromCharCode(c)))
    .join('');

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const ws = 'D:\\项目\\shop 😀';

describe('AUDIT-S3 ASCII-only isolation status JSON', () => {
  it('setup.ps1 sets UTF-8 output and escapes every char above 0x7E in Out-Result', () => {
    expect(setup).toContain('try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }');
    expect(setup).toContain("if ([int]$ch -gt 0x7E) { [void]$sb.Append('\\u').Append(([int]$ch).ToString('x4')) }");
    expect(setup).toMatch(/function Out-Result\(\$obj, \[int\]\$code\) \{ \(ConvertTo-AsciiJson \(\$obj \| ConvertTo-Json -Compress -Depth 6\)\) \| Write-Output; exit \$code \}/);
    // the setup.ps1 OutputEncoding line comes before the first Out-Result call
    expect(setup.indexOf('[Console]::OutputEncoding')).toBeLessThan(setup.indexOf('Out-Result ('));
  });

  it('a non-ASCII workspace root survives any single-byte decode and is parsed back exactly', () => {
    const raw = JSON.stringify({ state: 'ISOLATED', account: 'CompanyOSAgentab12cd', sid: SID, brokerPort: 47811, workspaceDirs: [ws], problems: [] });
    const line = asciiJson(raw);
    expect([...line].every((c) => c.charCodeAt(0) <= 0x7e)).toBe(true);
    // what a CP437/CP936 console does to ASCII bytes, then Node's UTF-8 decode: unchanged
    const throughConsole = Buffer.from(Buffer.from(line, 'latin1').toString('latin1'), 'utf8').toString('utf8');
    const s = interpretIsolationStatus(0, `${throughConsole}\r\n`);
    expect(s.state).toBe('ISOLATED');
    const d = isolationDispatchDecision(s);
    expect(d).toEqual({ kind: 'launch-isolated', account: 'CompanyOSAgentab12cd', sid: SID, brokerPort: 47811, workspaceDirs: [ws] });
  });

  it('degraded problems that carry a non-ASCII path are parsed back exactly', () => {
    const p = `acl:missing:Allow:FullControl:${ws}`;
    const s = interpretIsolationStatus(2, asciiJson(JSON.stringify({ state: 'ISOLATION_DEGRADED', problems: [p] })));
    expect(s.state).toBe('ISOLATION_DEGRADED');
    expect(s.problems).toEqual([p]);
  });

  it('installer smoke uses a non-ASCII workspace and checks the app-style hidden status read', () => {
    expect(smoke).toContain("('CompanyOS-HarkSmoke-' + [string][char]0x9879 + [string][char]0x76EE + '-workspace')");
    expect(smoke).toContain('$psi.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)');
    expect(smoke).toContain("Check 'h16-status-utf8-workspace'");
  });
});
