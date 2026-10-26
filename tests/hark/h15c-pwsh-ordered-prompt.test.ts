/**
 * H15c — the headless shell guard installs a readiness-ordered prompt (Windows ConPTY passes
 * OSC 133;D through ahead of buffered screen text, which invalidated the kernel's exact
 * marker+prompt readiness: hark-installer 40274121972 / 40275357324 / 40276998749 / 40278831200).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped test-data helper (.mjs)
import { renderFixtureText } from '../../scripts/prepare-offline-resources.mjs';

const ROOT = join(__dirname, '..', '..');
const guard = (): string => (renderFixtureText(readFileSync(join(ROOT, 'scripts/materialize-embedded-dsh.mjs'), 'utf8'), 'headless-shell-guard.ps1') as Buffer).toString('utf8');

describe('H15c headless guard ordered prompt', () => {
  it('shadows the kernel prompt function with an alias to the ordered prompt', () => {
    const text = guard();
    expect(text).toContain('function global:CompanyOSOrderedPrompt {');
    expect(text).toContain('Set-Alias -Name prompt -Value CompanyOSOrderedPrompt -Scope Global -Option ReadOnly -Force');
  });

  it('emits the same marker bytes and printable prompt as the kernel bootstrap, after a paint settle', () => {
    const text = guard();
    const body = text.slice(text.indexOf('function global:CompanyOSOrderedPrompt {'));
    const settle = body.indexOf('[System.Threading.Thread]::Sleep(120)');
    const marker = body.indexOf("[Console]::Write([char]27 + ']133;D;' + $code + [char]7)");
    const prompt = body.indexOf("'dsh> '");
    expect(settle).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(settle);
    expect(prompt).toBeGreaterThan(marker);
    // exit code is captured before anything in the prompt can change it
    expect(body.indexOf('$code = [int]$global:LASTEXITCODE')).toBeLessThan(settle);
  });

  it('keeps the WSH dispatch guard ahead of the prompt section', () => {
    const text = guard();
    expect(text.indexOf("New-Item -Path Function: -Name 'global:cmd.exe'")).toBeLessThan(text.indexOf('# H15c: readiness-ordered prompt'));
  });
});
