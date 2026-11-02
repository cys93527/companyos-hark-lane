/**
 * AUDIT-E2 (desktop): one unrecoverable run used to exit the app on every boot (bricked). Per-run recovery
 * failures are now quarantined (no driver, user told); every other recovery failure stays fatal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDesktopAutonomyRunner } from '../src/autonomy/desktop-autonomy-runner.js';
import { recoveryFailurePolicy } from '../src/startup-recovery-policy.js';

describe('AUDIT-E2 desktop recovery policy', () => {
  it('RUN_RECOVERY_FAILED with failures[] quarantines exactly those runs', () => {
    expect(recoveryFailurePolicy({ details: { reason: 'RUN_RECOVERY_FAILED', runId: 'r1', failures: [{ runId: 'r1' }, { runId: 'r2' }] } }))
      .toEqual({ kind: 'quarantine', runIds: ['r1', 'r2'] });
  });
  it('anything else stays fatal (fail closed)', () => {
    expect(recoveryFailurePolicy({ details: { reason: 'RUN_ENUMERATION_FAILED' } })).toEqual({ kind: 'fatal' });
    expect(recoveryFailurePolicy({ details: { reason: 'RUN_RECOVERY_FAILED' } })).toEqual({ kind: 'fatal' });
    expect(recoveryFailurePolicy({ details: { reason: 'RUN_RECOVERY_FAILED', failures: [] } })).toEqual({ kind: 'fatal' });
    expect(recoveryFailurePolicy({ details: { reason: 'RUN_RECOVERY_FAILED', failures: [{ nope: 1 }] } })).toEqual({ kind: 'fatal' });
    expect(recoveryFailurePolicy({})).toEqual({ kind: 'fatal' });
  });
  it('the autonomy runner never starts a quarantined run', () => {
    let runs = 0;
    const runner = createDesktopAutonomyRunner({
      companyId: 'co', logger: null, quarantinedRunIds: new Set(['bad']),
      driver: { run: async () => { runs += 1; return { ok: false, error: { code: 'X', message: 'x' } }; } } as never,
    });
    expect(runner.start('co', 'bad')).toBe(false);
    expect(runs).toBe(0);
  });
  it('main.ts quarantines per-run failures and keeps other failures fatal', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain("if (!recovery.ok && policy?.kind === 'quarantine') {");
    expect(main).toContain('quarantinedRunIds,');
    expect(main).toMatch(/} else if \(!recovery\.ok\) \{[\s\S]{0,400}app\.exit\(1\);/);
  });
});
