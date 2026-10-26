import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

describe('H15c pwsh terminal evidence (hark-live-goal 40266877047 hung 300 s in pwsh)', () => {
  it('the Windows PONG smoke drives the production pwsh terminal and gates its latency', () => {
    const smoke = read('scripts/hark/kernel-health-smoke.mjs');
    expect(smoke).toContain("name: 'pwsh'");
    expect(smoke).toContain('pwshToolMs <= 90_000');
    expect(smoke).toMatch(/const ok = pwshOk &&/u);
  });
  it('hark-installer records raw PTY evidence from the shipped node-pty before the smoke', () => {
    const wf = read('.github/workflows/hark-installer.yml');
    const probe = wf.indexOf('pwsh-pty-probe.mjs');
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(wf.indexOf('kernel-health-smoke.mjs'));
    const script = read('scripts/hark/pwsh-pty-probe.mjs');
    expect(script).toContain("'-NoExit', '-ExecutionPolicy', 'Bypass', '-File'");
    expect(script).toContain("']133;D;'");
  });
});
