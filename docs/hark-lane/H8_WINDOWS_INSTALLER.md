# H8 — Per-user Windows installer built and smoke-tested on CI (Hark lane)

Date: 2026-10-25 (HKT). Authorization: user approved building the installer on CI ("按照你的建议来", 2026-10-25 00:26 HKT).
Status: **Hark self-review PASS (H8 scope only)**. Independent Review NOT granted. Not a release, no tag, no full product acceptance.

## What was added (no new dependencies)
| File | Purpose |
|---|---|
| `scripts/hark/stage-desktop.mjs` | Assembles the portable app: Electron runtime (electron.exe → CompanyOS.exe, default_app.asar removed) + `resources/app` with desktop dist/preload, renderer dist, workspace packages (honouring each package's `files`, so `persistence/migrations` ships) and third-party prod deps (only `zod`). Self-check: every `*MigrationsDir()` exported by the staged persistence must exist. Writes `stage-manifest.json` (every file + sha256). |
| `installer/companyos.iss` | Inno Setup 6 script: per-user (`PrivilegesRequired=lowest`, no UAC), `%LOCALAPPDATA%\Programs\CompanyOS`, x64 only, Start-menu shortcut, optional desktop icon, uninstaller. Unsigned. |
| `scripts/hark/installer-smoke.ps1` | Silent install → launch 25 s → screenshot → kill tree → silent uninstall, 15 checks (exit codes, payload, HKCU entry, no HKLM entry, alive, log written, **no error-level log lines**, **DB bootstrapped**, sqlite created, no leftover process, dir and uninstall entry removed). |
| `.github/workflows/hark-installer.yml` | windows-2022, Node 24.19.0, pnpm 11.25.0. `pnpm install --frozen-lockfile --ignore-scripts` → `pnpm run build` → electron's own `install.js` (locked 44.5.1, checksum-verified) → stage → ISCC (preinstalled on the runner; the job refuses to download it) → smoke → upload artifacts. Push to hark-lane + dispatch. |

## Real results (keep first failure)
| Run | Commit | Result | Notes |
|---|---|---|---|
| 40112120130 | 25d2e4f | workflow green, **rejected by self-review** | desktop.log had 6 × `database bootstrap failed: Migration directory does not exist …\@companyos\persistence\migrations\`. Stage copied only `dist/`. The smoke did not inspect log levels, so it passed falsely. Installer sha256 F3CCDFA5…745B (superseded). |
| 40112501131 | d5ee0dd | **all 15 smoke checks ok** | stage log: `staged migrations: all resolvable directories exist`; 0 error-level lines; `database ready`, 29 `migration applied`, `window ready`, startup recovery complete; window title `CompanyOS`; screenshot shows the workspace chooser (选择工作空间目录…). |

Installer: `CompanyOS-Hark-Setup-0.1.0-x64.exe`, 115,496,559 bytes, sha256 `2592AC214AEB8D7D7D0C2850C46D333969F86391C9B1036429541D1FE7BCE9A8`.
Electron 44.5.1, electron.exe sha256 49B61A03…C7FA. Evidence: `lane/evidence/H8-installer/run-*/`.

## Failure / unknown matrix
| Item | State |
|---|---|
| Install / launch / uninstall on clean CI runner (runneradmin, interactive session) | PROVEN (run 40112501131) |
| Ordinary user's own PC (non-admin account, SmartScreen, AV) | NOT RUN — needs the user |
| Code signing | NONE — Windows will show "unknown publisher"/SmartScreen |
| Upgrade over an existing install, downgrade | NOT RUN |
| Uninstall keeps `%APPDATA%\CompanyOS` (user data/DB/logs) | BY DESIGN, recorded (`userDataKeptAfterUninstall: true`) |
| Installer UI language | English (Inno default); app UI is Chinese |
| DSH embedded runtime (`.companyos-embedded/dsh-runtime`) | NOT SHIPPED (Provider/DSH not approved); expected to fail closed when used |
| `native.job` production wiring | NOT WIRED (needs separate approval) |
| 200 × info `applied migration file is no longer present` | Pre-existing: several migration sets share one `schema_migrations` table; info level, not a packaging defect |
| asar packaging / auto-update | Not used / none |

## Reproduce
Push to `hark-lane` (or dispatch `hark-installer`), then `lane/fetch-installer.sh <sha> lane/evidence/H8-installer`.

## Review request
Independent reviewer: verify installer hash against the run artifact, re-run the workflow, and install on a real non-admin Windows account.
