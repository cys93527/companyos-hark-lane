// H13 — upgrade / downgrade / uninstall retention harness shape (the proof itself runs on
// Windows CI: .github/workflows/hark-upgrade.yml + scripts/hark/upgrade-retention.ps1).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const iss = readFileSync('installer/companyos.iss', 'utf8');
const installer = readFileSync('.github/workflows/hark-installer.yml', 'utf8');
const upgrade = readFileSync('.github/workflows/hark-upgrade.yml', 'utf8');
const ps = readFileSync('scripts/hark/upgrade-retention.ps1', 'utf8');
const probe = readFileSync('scripts/hark/h13-data-probe.mjs', 'utf8');

describe('H13 upgrade retention harness', () => {
  it('every install replaces the app payload whole (no stale newer files after a downgrade)', () => {
    expect(iss).toMatch(/\[InstallDelete\]\s*\n(?:;.*\n)*Type: filesandordirs; Name: "\{app\}\\resources"/u);
  });
  it('the probe-newer installer is a copy of the same stage + one CI-only migration, never in the repo chains', () => {
    expect(installer).toContain('h13-0010_h13_upgrade_probe.sql');
    expect(installer).toContain('name: hark-installer-next');
    expect(() => readFileSync('packages/persistence/migrations/engine/0010_h13_upgrade_probe.sql')).toThrow();
  });
  it('runs after hark-installer on the same commit and checks upgrade, downgrade refusal, uninstall retention, recovery', () => {
    expect(upgrade).toContain('workflows: [hark-installer]');
    for (const check of ['p2-probe-migration-applied', 'p2-owner-role-row-kept', 'p3-typed-refusal-logged', 'p3-data-logically-unchanged', 'p3-no-stale-newer-payload', 'p4-userdata-db-kept', 'p5-data-survived-uninstall', 'p5-database-ready']) {
      expect(ps).toContain(check);
    }
    expect(ps).toContain('SCHEMA_FROM_NEWER_VERSION');
  });
  it('the data probe is read-only', () => {
    expect(probe).toContain('{ readOnly: true }');
    expect(probe).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/u);
  });
});
