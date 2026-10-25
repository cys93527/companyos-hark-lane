# H13 — upgrade / downgrade / uninstall data retention (installed app, Windows CI)

Hark lane, self-review only (Hark self-review PASS when CI is green; not an independent review).

## What is proven
`.github/workflows/hark-upgrade.yml` (runs after `hark-installer` for the same commit) drives `scripts/hark/upgrade-retention.ps1` against the REAL per-user install and userData (`%APPDATA%\CompanyOS`), with real GUI launches:

| Phase | Action | Checks |
|---|---|---|
| p1 | install vN, launch | DB created (`database ready`), owner role row present, no probe table |
| p2 | install vN+1 over it (upgrade) | version increased; DB ready; every prior migration kept; probe migration applied; owner role row identical |
| p3 | install vN over it (downgrade) | no stale newer payload; typed refusal `SCHEMA_FROM_NEWER_VERSION` naming the unknown migration in the app log; shell still alive (banner 「数据来自更新版本的 CompanyOS」); data logically unchanged (migrations, every table's row count, owner row) |
| p4 | uninstall | install dir removed; userData DB kept |
| p5 | install vN+1 again | data before launch identical to p2; DB ready again |

Snapshots: `scripts/hark/h13-data-probe.mjs` on the installed runtime (`ELECTRON_RUN_AS_NODE=1`), `node:sqlite` read-only, no migration, no composition.

## vN+1 ("probe-newer") build
`hark-installer` packages a second installer from a COPY of the same staged app, one patch version up, with ONE CI-only migration (`scripts/hark/fixtures/h13-0010_h13_upgrade_probe.sql` → `engine/0010_h13_upgrade_probe.sql`). It is uploaded as `hark-installer-next` and never enters the repository's migration chains.

## Defect found and fixed at the root
Inno Setup never removes files that a previous version installed. A downgrade over a newer install would have kept the newer build's files (here: the newer migration), silently mixing two versions and defeating the downgrade refusal. `installer/companyos.iss` now has `[InstallDelete] Type: filesandordirs; Name: "{app}\resources"`: every install replaces the app payload whole; userData is untouched. Check `p3-no-stale-newer-payload`.

Depends on H12c (a): the shipped build refuses a database that a newer build migrated.

## First CI run red, fixed at the root (H13b)
hark-upgrade 40212306477 @4a9ba6a failed one check, `p5-no-bootstrap-failure`. The p5 launch itself was healthy (`database ready`, schemaVersion 10). Two real defects behind it:
1. Harness: the app APPENDS to its log across launches, and `Launch` read every log file touched since the launch, i.e. the whole file, so p5 saw p3's (expected) refusal lines. `upgrade-retention.ps1` now records each log file's line count before a launch and reads only the lines that launch appended.
2. Product: in the p3 downgrade launch the 0.1.0 app logged `database bootstrap failed … SCHEMA_FROM_NEWER_VERSION` six times: every renderer call re-entered the lazy workflow bootstrap and re-opened the newer database. The refusal is terminal for the process; `apps/desktop/src/database-bootstrap-policy.ts` (`isDatabaseBootstrapRetryable`) now stops the re-open (only `OPEN_FAILED` is retried). New CI check `p3-refusal-not-retried` (exactly one refusal line per launch); unit test `apps/desktop/tests/h13-database-bootstrap-policy.test.ts`.

## CI
Run ids and results: PROJECT_HANDOFF.md (H13 section).
