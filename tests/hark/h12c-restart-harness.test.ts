// H12c — the installed-app restart proof kills p1 from OUTSIDE (TerminateProcess), never a
// cooperative process.exit, and adds the operator-reconciliation phase p4.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync('scripts/hark/restart-unknown.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/hark-restart.yml', 'utf8');

describe('H12c restart harness', () => {
  it('p1 never exits by itself: ready marker, then blocks until killed', () => {
    expect(script).not.toContain('finish(0, { close: false })');
    expect(script).toContain('await awaitHardKill(); // never resolves');
    expect(script).toContain("'p1-ready.json'");
  });
  it('the workflow terminates p1 with Stop-Process -Force after the marker and records it', () => {
    expect(workflow).toContain('Stop-Process -Id $p1.Id -Force');
    expect(workflow).toContain('p1-kill.json');
    expect(workflow).toMatch(/\$p1 = Start-Process (?:(?!-Wait).)*-PassThru/u);
  });
  it('p4 runs after the operator tool writes the attestation; all four phases must pass', () => {
    expect(workflow).toContain("foreach ($ph in 'p2','p3','p4')");
    expect(workflow).toContain('scripts/hark/make-usage-reconciliation.mjs');
    expect(workflow).toContain('$codes.Count -ne 4');
    expect(script).toContain("usageReconciliationDir: budgetDir");
    expect(script).toContain('P4-reservation-KNOWN-from-attestation');
  });
});
