# DESKTOP RUNTIME COMPATIBILITY — Electron `node:sqlite` V1 Blocker Fix

Status: **CLOSED** (2026-10-04). Deliverable for the task
`COMPANYOS DESKTOP RUNTIME UPGRADE — ELECTRON NODE:SQLITE V1 BLOCKER FIX`.

Parent: [DESKTOP_CLIENT_STAGE1.md](./DESKTOP_CLIENT_STAGE1.md) (canonical Goal client, commit `54f8c5a`).
Forensic baseline: `E:\DeepSeek.gzq\companyos-desktop-stage1-smoke\DESKTOP_SQLITE_FORENSIC_REPORT.md` (read-only).

---

## 1. TL;DR

The desktop client could not launch at all: the main process threw
`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` during startup, because the pinned Electron
bundled a Node that predates `node:sqlite`. The fix is one dependency change — Electron
**33.4.11 → 44.5.1** (exact pin), whose bundled Node 24.21.0 provides `node:sqlite`
unflagged. ADR-0001 (single SQLite driver, one `openDatabase()` seam) is preserved
**untouched**: no second driver, no JSON persistence, no bypass.

A second, independent blocker was exposed by the first real boot and is fixed in the same
commit: the desktop stamped its session actor from `USERNAME`, which made every IPC request
and startup recovery fail `POLICY_DENIED` on any machine whose OS account is not literally
`owner`. The default is now the runtime composition's single actor, `user_owner`.

The Stage-1 product smoke then completed on the real app (section 8). One product-level
finding and two UX gaps are recorded in section 9.

---

## 2. Runtime evidence (old vs new)

| Item | Before | After |
|---|---|---|
| Electron (apps/desktop) | `33.4.11` (`"electron": "^33.0.0"`) | **`44.5.1`** (exact pin, no range) |
| Bundled Node | `20.18.3` | **`24.21.0`** |
| Bundled Chromium / V8 | — | Chrome `152.0.7977.130`, V8 `15.2.124.28-electron.0` |
| `node:sqlite` | **absent** (`ERR_UNKNOWN_BUILTIN_MODULE`) | **present**, `DatabaseSync` is a function |
| Launch | main process dies at load | full boot to `window ready` |

Live probe inside the real Electron runtime (`ELECTRON_RUN_AS_NODE=1`, the app's own
installed Electron binary):

```
{"node":"24.21.0","chrome":"152.0.7977.130","v8":"15.2.124.28-electron.0",
 "electron":"44.5.1","sqlite":"PASS","roundtrip":1}
```

`roundtrip` = one `CREATE TABLE` + `INSERT` + `SELECT` executed against a real
`node:sqlite` connection inside the Electron process.

---

## 3. Root cause

1. `packages/persistence/src/db.ts:9` has the **only** `node:sqlite` import in the repo
   (`DatabaseSync`); the whole SQLite surface opens through `openDatabase()`. That
   single-seam containment (ADR-0001) is what made the runtime mismatch a *launch* blocker
   rather than a scattered polyfill problem.
2. `node:sqlite` was added in Node 22.5 (flagged) and became unflagged in Node 24.
   Electron 33 bundles Node 20.18.3, where the module does not exist.
3. `pnpm check` still passed because the gate runs entirely on the **system** Node
   (24.19.0) — vitest and tsc never launch Electron, and CI explicitly skips the Electron
   binary (`ELECTRON_SKIP_BINARY_DOWNLOAD: '1'`). The failure mode was invisible to every
   automated gate and could only be caught by a real-process launch.

---

## 4. Selected fix — and what was deliberately NOT done

**Option A (chosen): upgrade Electron to a release whose bundled Node provides
`node:sqlite` unflagged.** Electron 44.x is the current stable 44.x line; 44.5.1 was
resolved from the registry and pinned exactly (`"electron": "44.5.1"`, not a range), so a
future 45.x cannot silently move the bundled Node under the product.

Rejected, and recorded so the decision is not re-litigated:

* **Option B — a second driver** (`better-sqlite3`, `sql.js`, `node-sqlite3`): rejected.
  It breaks ADR-0001, adds a native dependency and a second durability model, and would
  make "one SQLite truth" false.
* **Option C — bypass** (`--experimental-sqlite`, a JSON file, mocked persistence, or a
  "UI-only" mode that skips the DB): rejected. Every one of those makes the durable truth
  the UI reads different from the durable truth the engine writes.

Nothing else was upgraded: the diff touches exactly three files
(`apps/desktop/package.json`, `apps/desktop/src/main.ts`, `pnpm-lock.yaml`).

---

## 5. Breaking-change audit (Node 20.18.3 → 24.21.0 and Electron 33 → 44)

Electron API surface used by the main process (`apps/desktop/src/main.ts`,
`security.ts`): `app`, `BrowserWindow`, `dialog`, `ipcMain`, `session`, `shell`,
`webContents` — all stable, none deprecated or behavior-changed in 44. The main process
does not use `nodeIntegration`, `contextIsolation` stays `true`, the renderer stays
sandboxed, and the preload is still the only CommonJS bridge.

Node builtins used by the main process: `node:path`, `node:url`, `node:fs`, `node:crypto`
(`main.ts`, `workspace-selection.ts`, `executor/*`) and `node:http` / `node:https` /
`node:net` (`executor/embedded-dsh-runtime.ts`, the embedded kernel transport). Every one
of these APIs is unchanged between Node 20 and 24 for the calls this codebase makes — no
removals, no signature changes, no behavioral flags to re-set.

`packages/persistence` is unchanged; it now simply finds `node:sqlite` where it expects it.

---

## 6. Second blocker found by real boot: session actor

Symptom on the first successful boot under Electron 44: the window opened but every IPC
request failed `POLICY_DENIED: Actor "user_Administrator" is not the session actor`.

Cause: `apps/desktop/src/main.ts` derived the stamp `SESSION_ACTOR` from
`process.env['USERNAME']`, while the runtime composition (core-services) hardcodes the
single-user V1 actor `user_owner`. The renderer never chooses its identity (correct), so
the mismatch made *every* request — and startup recovery — unauthorized on any host whose
OS account is not literally `owner`.

Fix: the default is now the runtime's single actor (`'user_owner'`), and the env override
remains as the future sign-in seam. The security property is unchanged: the renderer still
cannot choose who it is; only the main process stamps identity.

---

## 7. Security invariants (preserved, and re-verified)

| Invariant | Status |
|---|---|
| ADR-0001 single SQLite driver / one `openDatabase()` seam | **preserved** — no change to `packages/persistence` |
| Renderer has no Node/Electron/SQLite surface | **verified at runtime** — `require`, `process`, `module`, `global`, `Buffer` are all `undefined` in the renderer; `process.versions` not exposed |
| IPC is allow-listed | **verified at runtime** — bridge exposes exactly 9 methods over exactly 8 channels (`app-version`, `platform-info`, `database-status`, `workflow`, `control-plane`, `workspace-select`, `workspace-open`, `workspace-current`) |
| Renderer never receives credentials | **verified** — no `api_key`/`Bearer`/`sk-…`-shaped string anywhere in the rendered DOM; `localStorage` empty; all provider secrets stay in the main process |
| CSP / contextIsolation / sandboxed renderer | unchanged |

---

## 8. Real Electron proof and the Stage-1 product smoke

Launched with the app's own Electron 44.5.1 binary and driven through CDP against the
actual renderer (real `Input.dispatchMouseEvent` clicks at real coordinates, real React
state, real IPC — no fixture stubs).

### 8.1 Real boot (post-fix, before any interaction)

```
database ready          path=…\AppData\Roaming\@companyos\desktop\data\companyos.sqlite
                        journalMode=wal schemaVersion=7 migrationsApplied=0
artifact CAS reconciled casRoot=…\artifacts artifactsChecked=1 orphanCasObserved=0
startup recovery complete runsScanned=1 runsRecovered=0 runsPaused=0 manualInterventionRequired=0
router audit reconciled  decisions=0 repaired=0
window ready             bridge=companyos dev=true
```

The database opens through the canonical `openDatabase()` seam on `node:sqlite` — the V1
blocker is closed by this line alone.

### 8.2 Stage-1 product smoke (fresh disposable workspace)

Workspace: `E:\DeepSeek.gzq\companyos-desktop-stage1-smoke\project-files`
(`notes.txt`, `data.csv`).

| Step | Result |
|---|---|
| Native chooser reachable from the UI | **PASS** — clicking the selector opened a real OS dialog titled *"Select the CompanyOS workspace directory"*; `ESC` cancelled it and the client resolved `null` (cancel is not an error) |
| Select workspace | **PASS** — trusted-open channel accepted the real path; the selector showed `当前工作空间：E:\…\project-files` |
| Goal entry gating | **PASS** — `goal-entry` / `goal-list` only render once a workspace is open; without one the submit button is disabled with the hint *"先选择工作空间，再开始目标。"* |
| Create exactly one canonical Goal | **PASS** — objective typed into the multi-line entry, real click on `开始目标`; `goal.create` returned `run_01M43QKDTG6FCH8SJ18Z61FYY8`, and `home.summary` returned exactly one goal |
| Canonical DB verification | **PASS** — `runs` held exactly **one** row: `run_01M43QKDTG6FCH8SJ18Z61FYY8`, `company_default`, `wf-companyos-goal`, `IDLE`, `started_by=user_owner` |
| Open Goal detail | **PASS** — clicking the list row navigated to the detail view; it renders **only** canonical projections: 状态 `IDLE`, 规划 Run `run_01M43QKDTG…·IDLE`, `任务 0/0 完成 · 阶段 0/1 终态成功 · 尝试：完成 0 · 失败 0 · 活跃 0`, `验证 尚无验证记录。`, `执行 Run 尚未编译出执行 Run（先推进一次规划）。`, `阻塞与待决策 无阻塞。` — **no fake percentage, no "time remaining", activity never rendered as progress** |
| Fully close Electron | **PASS** — `Browser.close`; 0 `electron.exe` processes remained and CDP went down. The `-wal`/`-shm` files were gone afterwards: the app checkpointed WAL cleanly on exit |
| Relaunch + workspace restore | **PASS** — on the next boot the workspace was rehydrated automatically from `userData/workspace-selection.json` (no re-selection), and `runsScanned=1` in startup recovery |
| Rehydrate the same Goal, no duplicate | **PASS** — the list showed exactly one row, the **same** `run_01M43QKDTG6FCH8SJ18Z61FYY8` with the same `createdAt`; no duplicate row existed |
| Security smoke | **PASS** — section 7 |

Screenshots (in `companyos-desktop-stage1-smoke/`): `smoke-goal-detail.png`,
`smoke-goal-list.png`, `smoke-after-relaunch-detail.png`, `smoke-after-relaunch-list.png`.

### 8.3 Smoke prerequisites (documented honestly)

`goal.create` fails closed with `MODEL_SELECTION_REQUIRED` on a fresh database, because the
canonical command refuses to guess a model. Two prerequisites were therefore completed
through the **real workflow bridge** (`companyos:workflow`):

1. `models.register` for one provider model — `model.openai-compatible/deepseek-v4-flash`
   (the provider adapter rebinds and validates its catalogue on every boot anyway, so this
   added no new class of network activity, and **no completion/invocation was ever
   requested** — no prompt, no tokens, no Goal execution).
2. `models.policy` with `scopeType=COMPANY`, `scopeId=company_default`, `mode=MANUAL`.

`models.policy.explain` returned `accepted: true`, `precedence: EXPLICIT_USER_CHOICE`,
`fallback: NEVER`. Neither operation has a form in the Stage-1 UI (see F-2).

---

## 9. Findings from the smoke (for Stage 2)

* **F-1 (product, P3) — duplicate Goals on re-submission.** `GoalEntry` generates its
  canonical `commandId` as a per-mount random value (`ui-<ts>-<rand>`), so the "same text
  replays the same run" protection only holds while the entry stays mounted. Observed:
  submitting the identical objective again after navigating list→detail→list created a
  **second** canonical Goal (`run_01M43QS1D6GGHHVCQVHN602669`), and once more after that
  (`run_01M43QSXNR3BM7WYWT575QCM9M`). Deriving the command id from the objective text
  (scoped to the workspace/company) would make resubmission replay the original Goal.
  *These probe rows are durable truth and were deliberately not deleted or edited.*
* **F-2 (UX gap, P3) — no forms for two required prerequisites.** Model registration and
  the **COMPANY-scoped** selection policy have no UI surface; the only policy form saves
  `scopeType=ROLE, scopeId=developer`, which cannot satisfy `goal.create`'s
  company-level resolution. Stage 1 therefore leaves an admin to call the bridge directly.
* **F-3 (environment, not a product defect) — this host cannot sustain a windowed
  Chromium session.** After the window loads, the host's Chromium GPU process dies with an
  access violation (`0xC0000005`) on every launch, and Chromium aborts the browser process
  after its GPU fallbacks are exhausted (`GPU process isn't usable. Goodbye.`). This was
  **controlled**: a minimal Electron 44 app (one window, `data:` URL, hardware acceleration
  disabled) crashes identically, so it is a host GPU/driver defect, not a CompanyOS defect.
  `--disable-gpu`, `--disable-gpu-compositing`, `--in-process-gpu`, `--single-process`,
  `--use-gl=disabled` and SwiftShader ANGLE were all tried; none helped, and a sandboxed
  Electron cannot start on this host at all (silent exit 3). The interactive smoke was
  therefore executed on the **headless rendering path** (`--headless`), where the real main
  process, preload bridge, renderer, DOM and `node:sqlite` all run unchanged. A healthy
  host needs no such flag; no flag or code change was added to the product for this.

---

## 10. Backlog status

| Item | Before | After |
|---|---|---|
| `DESKTOP_ELECTRON_NODE_SQLITE_RUNTIME_COMPATIBILITY` (desktop cannot launch: bundled Node lacks `node:sqlite`) | **OPEN P1** — V1 product blocker | **CLOSED** by this fix (Electron 44.5.1 + session-actor alignment) |

Open P1 in this scope: **0**. Open P0: 0.

---

## 11. Reproduce

```bash
# node:sqlite inside the real Electron runtime
ELECTRON_RUN_AS_NODE=1 \
  node_modules/.pnpm/electron@44.5.1_supports-color@7.2.0/node_modules/electron/dist/electron.exe probe.js

# real boot + interactive smoke (this host needs the headless rendering path — see F-3)
cd apps/desktop && pnpm run build
npx electron . --no-sandbox --headless --remote-debugging-port=9444
# then drive the real UI over CDP (Input.dispatchMouseEvent + Runtime.evaluate)
```

## 12. Explicitly NOT done (per task constraints)

No tag, no Stage 2, no UI redo, no Session Runtime, no other dependency upgrade, no V1.1,
no extra live-provider Goal, no change to canonical durable truth, no direct DB edits.
