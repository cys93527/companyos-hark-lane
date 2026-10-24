# DESKTOP CLIENT STAGE 2 — ChatGPT-first UX + ZCode reference + canonical runtime view

Status: **Implemented** (2026-10-05). Baseline `2435ed3` → this commit.
Parent: [DESKTOP_CLIENT_STAGE1.md](./DESKTOP_CLIENT_STAGE1.md),
[DESKTOP_RUNTIME_COMPATIBILITY.md](./DESKTOP_RUNTIME_COMPATIBILITY.md).

---

## 1. TL;DR

The Stage-1 shell became a real product surface: a ChatGPT-like three-area shell (LEFT
navigation + history, CENTRE conversation, RIGHT collapsible CompanyOS runtime panel), a
composer with the Codex/ZCode-style 访问权限 control, a model selector whose popover shows
**only** telemetry the canonical truth can support (`--` for unknown), and — most
importantly — the **normal user's model-selection path**, which closes the
`MODEL_SELECTION_ONBOARDING_GAP` Stage 1 exposed. Autonomy now runs in the main process, so
after Send the operator never clicks 继续 again.

One real defect was found and fixed by the real boot (see §7, F-1): the bridges were
re-created on every render, so the submission-intent replay effect ran on every render and
replayed one Goal 4095 times.

---

## 2. ZCode reference (Phase 0B — read-only, outside CompanyOS)

| Field | Value |
|---|---|
| Repository | `zai-org/ZCode` |
| REFERENCE_COMMIT | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` (short `29628c9`, 2026-09-24) |
| REFERENCE_VERSION | `3.14.3` |
| LICENSE | Apache-2.0 |
| Cloned to | `E:\DeepSeek.gzq\zcode-reference` (outside CompanyOS; not imported) |

Mechanisms reviewed (TUI package `apps/zcode-cli/packages/tui/src/`) and classified:

| Area | Mechanism | Class |
|---|---|---|
| Shell | left sidebar = live session telemetry + workspace inspector; leader-key toggle | ADAPT_UX (telemetry-first sidebar), but nav/recent/settings designed fresh |
| Transcript | user rows carry chrome, agent rows don't; compaction as a timeline row | ADAPT_UX |
| Composer | terminal constraint removed buttons entirely; status row + queue panel | ADAPT_UX (keep queue/status idea; desktop needs real buttons) |
| Permission | **two layers**: access/mode selector (`plan/build/edit/yolo`) + blocking per-tool approval with "Allow once / Always allow in project / Deny" | ADAPT_UX — the 访问权限 dropdown position and the blocking approval card are the direct answer to the user's requirement |
| Model selector | inline `/model` panel, no compact popover, no context/usage | DEFER the picker's shape; ADAPT_UX `disabledReason \| current` row meta |
| Telemetry | every unknown value renders `-`, never a fabricated number; `used (pct%)` badge | **ADAPT_UX — copied verbatim** (ours renders `--`) |
| Tool calls | flat redacted rows, capped diff/output with explicit "[truncated N lines]" | ADAPT_UX |
| Workspace | modified-files strip; no explorer | ADAPT_UX |
| Streaming | status text + spinner, never a fake progress bar | **ADAPT_UX — copied verbatim** |
| Settings | none in TUI (slash commands) | REJECT — a desktop client gets a normal settings route |
| Session/history | absent | DEFER |
| Submission | busy/queue split + host-authoritative idempotency token | ADAPT_UX (ours: `submissionIntentId` as the canonical `commandId`) |

Hard rule honoured: **ZCode Session/Task/Agent/Runtime truth never becomes CompanyOS
truth.** CompanyOS remains authoritative for Goal, Plan, Run, Task, Role, ExecutionAttempt,
Validation, Corrective, Handoff, Outcome and Authority. No ZCode code is imported; only UX
mechanisms were studied.

---

## 3. UX architecture

```
┌────────────┬───────────────────────────────┬───────────────────┐
│ LEFT       │ CENTRE (conversation-first)   │ RIGHT             │
│ CompanyOS  │  Goal = the user's message    │ CompanyOS 运行视图 │
│ + 新建目标  │  derived response surface     │  collapsed by      │
│ 首页        │  (canonical projections only)│  default           │
│ 对话与任务  ├───────────────────────────────┤  运行 运行时/文件/   │
│ 知识库      │ composer                      │  产出 详情          │
│ 工具        │  [+] 访问权限▾ 工具  model▾ 发送 │                   │
│ 智能体      │                               │                   │
│ …最近…     │                               │                   │
│ 设置(bottom)│                               │                   │
└────────────┴───────────────────────────────┴───────────────────┘
```

Frozen visual direction (ChatGPT-desktop-like): light neutral surfaces, subtle borders,
minimal shadows, generous whitespace, one blue accent. No enterprise dashboard, no
permanent metric wall, no marketing graphics, no dense DevOps console by default. Telemetry
belongs in the model popover; runtime detail belongs in the collapsible panel.

Files: `apps/renderer/src/shell.tsx` (layout + sidebar + settings), `chat.tsx`
(conversation), `composer.tsx` (composer + 访问权限 + model selector + runtime popover),
`models.tsx` (model onboarding), `runtime-panel.tsx` (runtime panel), `surfaces.tsx`
(知识库/工具/智能体), `telemetry.ts` (honest telemetry semantics),
`submission-intent.ts` + `intent-store.ts` (submission intent).

**No Team Plan / Pro badge / task quota / subscription card exists anywhere** (UX-03).

---

## 4. Composer contract

| Position | Affordance | Backing |
|---|---|---|
| left | `[ + ]` | change the workspace (the ONE operational context) |
| left | `[ 访问权限 ▾ ]` | **display-only** — derived from canonical run state + blocker codes; mutation deferred to Stage 3 |
| left | `[ 工具 ]` | canonical tool registry (`tools.list`) |
| right | `[ <model> ▾ ]` | canonical COMPANY model selection |
| right | `[ 发送 ]` | ONE submission intent (§6) |

### Authority mapping (display-only)

The CompanyOS authority seam is not renderer-writable, so the composer shows the **current
effective authority** derived from canonical projections and says so:

| Canonical basis | Label |
|---|---|
| blocker `APPROVAL_REQUIRED` | 询问权限 |
| run state `EXECUTING` / `RUNNING` | 工作区操作 |
| anything else (no run, terminal, failed) | 只读 |

The popover states the derivation basis and "只读展示：权限由 CompanyOS Authority / Approval
治理，界面不创建、不保存、不切换权限（Stage 3 映射）". High-risk operations remain governed by
canonical Approval/Authority; there is no renderer-owned permission truth, no localStorage
permission authority, no UI-only fake safety mode.

---

## 5. Model selector + runtime popover

The selector opens a compact popover listing what a **configured provider actually offers**
(the durable `provider_models` catalogue — new read-only operation `models.catalogue`), each
row marked 已注册 / 未注册. Choosing one runs the canonical flow: `models.register` (only when
needed) → `models.policy` (COMPANY scope, MANUAL) → `models.policy.explain`.

The model runtime popover shows:

```
上下文 128,000      剩余 --      已使用 --
生成速度 --         缓存命中 --    会话费用 --
暂无可用遥测（E1 用量投影未对界面暴露，未知值显示 --）
```

Semantics (the frozen rule): `KNOWN` renders the value (an observed true zero renders `0`,
never as unknown); `ESTIMATED` renders `≈`; `UNKNOWN` renders `--`. Context remaining is
derivable only when both the context window and the observed usage are known. Token usage
uses existing usage truth (E1's ledger is main-process only and not IPC-exposed, so the
renderer truthfully reports UNKNOWN). Speed appears only when measured. Cache hit appears only
when the provider/kernel exposes cached-token evidence — never inferred from repeated
commands, prompt similarity or workspace reuse. Session cost is KNOWN (authoritative tokens ×
declared price) or explicitly ESTIMATED; otherwise `--`.

---

## 6. Submission-intent semantics (F-1 closure)

Identity rule: **ONE USER SUBMISSION INTENT is idempotent.** The intent id is *not* derived
from the objective text (the same text may legitimately be executed twice on purpose) and it
is *not* a per-mount random value (it must survive a remount/reload while unacknowledged).

So the intent id lives in a bounded client outbox (`companyos.submission-intent.v1`, one
record) and **is** the canonical `commandId` handed to `goal.create`. The canonical
command-id ledger remains the idempotency authority; the outbox only remembers the identity
of an intent the canonical command has not acknowledged yet.

| Case | Behaviour |
|---|---|
| A. double-click Submit | the second submission is blocked while one intent is unresolved → ONE Goal |
| B. transport retry of the same intent | `retry()` replays the SAME intent id → ONE Goal (status `replayed`) |
| C. renderer remount/reload before ack | on mount the pending intent is resolved first (replay of the same id); a fresh submission is only accepted afterwards → no silent duplicate |
| D. explicit new submission of the same text | a NEW intent id → a NEW Goal is allowed |

---

## 7. Autonomy (no manual Continue)

`apps/desktop/src/autonomy/desktop-autonomy-runner.ts` is a THIN main-process launcher around
the already-composed canonical Stage-9 autonomy driver (`CoreServices.autonomyDriver`):

* exactly ONE active driver per Goal run (a second start is refused, never duplicated);
* `goal.create` through the IPC bridge starts the driver for the new run immediately;
* on startup, every **non-terminal** goal run in durable truth gets its driver back
  (`runs.list` filtered to `wf-companyos-goal` minus `RUN_TERMINAL_STATES`) — restart relies on
  canonical durable recovery, never renderer memory;
* the loop stops on terminal success/failure, PAUSED, an approval/authority decision, or a
  true external blocker — all classified **inside** the canonical driver;
* the launcher owns no domain truth, decides nothing about Tasks/Attempts/Validation and is
  not a second scheduler.

Update strategy: the renderer only re-reads canonical projections through bounded,
lifecycle-bound polling (4s while a run is live, stops on terminal) — no second realtime
backend.

---

## 8. Runtime panel

Collapsed by default (the centre stays conversation-first). Expanded tabs: **运行 / 文件 / 产出 / 详情**.

* **运行** — canonical lifecycle: 目标 (run state), 规划 (planning run state), each task with
  its canonical state, attempt label, and BOTH bindings shown separately (角色 X · 模型 Y —
  Role ≠ Model), then 验证 counts, 纠正轮次, 移交 count and the Outcome. Below it, the
  canonical activity list (`run.timeline`). **Activity is never converted into a percentage.**
* **文件** — canonical artifact references only. No open/reveal action: no safe canonical
  file-surface seam exists yet (Stage-3 handoff) and the renderer must not gain arbitrary
  filesystem access.
* **产出** — Outcome / Validation / Handoff, with the explicit note that artifact prose can
  never substitute for canonical Validation.
* **详情** — the selected task's canonical `run.task` projection (role, model, provider,
  state, attempts, start time, provider state). No raw chain-of-thought, no secrets.

---

## 9. Settings (bottom-left)

Stage-2 minimum: workspace path, provider configured/unconfigured, provider catalogue count,
registered-model count, the current COMPANY model selection, app version, database path,
schema version, IPC allow-list. No giant settings centre; provider credentials are **not**
managed here (no safe client-side write seam exists — onboarding stays a main-process /
provider concern, and an unconfigured provider shows 尚未配置模型提供商 with navigation to
Settings).

---

## 10. Real-boot smoke (deterministic, offline)

Launched the real Electron 44.5.1 app on this host with a **deterministic local provider
stub** (speaks just enough of the OpenAI-compatible protocol: a fixed `/models` catalogue and
a canonical plan proposal) and a **fresh userData**, so no live provider call and no long Goal
was involved. The host GPU defect recorded under F-3 of
[DESKTOP_RUNTIME_COMPATIBILITY.md](./DESKTOP_RUNTIME_COMPATIBILITY.md) still applies, so the
interactive run used the headless renderer path; the app bundle, preload bridge, IPC, main
process and node:sqlite database are identical either way.

Driver: a harness page loading the real built bundle, driving the real UI with real DOM
events and reading state through the real preload bridge.

| Smoke step | Result |
|---|---|
| boot | Stage-2 shell rendered: sidebar, composer, runtime panel, Settings bottom-left |
| workspace | trusted-open accepted the smoke workspace; shell rendered |
| model catalogue | 2 provider models listed with context windows (尚未选择公司模型) |
| model selection | **UI click** → register (canonical) + COMPANY policy saved; composer label `deepseek-v4-flash`; **send enabled** |
| Goal creation | composer input + send → exactly **one** canonical Goal `run_01M43XEXQ4KGNB5FYW0EX7SA8D`; chat rows show canonical facts only |
| validation projection | `验证 · 完成 0 · 失败 0 · 缺失 0` (canonical boolean `failed`, never `undefined`) |
| autonomy | **exactly one** driver start; stopped at the canonical boundary `EXTERNAL_PRECONDITION_BLOCKED / EXECUTOR_PROVIDER_UNKNOWN` (no work-executor provider on this host) — no manual 继续 clicked, no fabricated progress |
| runtime panel | collapsed by default ("已收起 — 对话优先") |
| model popover | `上下文 128,000 · 剩余 -- · 已使用 -- · 生成速度 -- · 缓存命中 -- · 会话费用 --` + 暂无可用遥测 |
| restart | relaunched: `resumedRuns=1` for the same run, the same single Goal rehydrated (no duplicate), COMPANY selection still MANUAL/deepseek-v4-flash, workspace restored |

Evidence: `E:\DeepSeek.gzq\companyos-desktop-stage1-smoke\stage2-smoke-report.json`,
`stage2-restart-report.json` (harness/dist tooling removed after the run; dist is git-ignored).

---

## 11. Findings

* **F-1 (defect found and fixed by the real boot)** — the renderer rebuilt its
  `controlPlane`/`workflow` bridges on every render, so the submission controller was rebuilt
  on every render and its mount effect re-ran: one unacknowledged submission intent was
  replayed 4095 times in ~100 s (each replay created no new Goal — the canonical command-id
  ledger held — but each one re-started the autonomy driver). Fix: memoise the bridges on the
  preload object and make the intent-resolution effect mount-only. Regression test: the
  real-boot smoke now shows exactly ONE driver start.
* **F-2 (UX gap, P3)** — `validation.failed` is a canonical **boolean**, and the first
  Stage-2 projection read it as an array (rendering `失败 undefined`). Caught by the smoke,
  fixed, and pinned by a test.
* **F-3 (environment, from Stage 1)** — the host's Chromium GPU process AV-crashes on every
  launch (proven with a minimal Electron app). No product GPU workaround was added. **Release
  requirement recorded: before Product V1 Freeze, perform one visible non-headless Windows
  Desktop smoke on a normal supported graphics environment.**
* **Stage-3 handoff** — authority mutation mapping; file reveal/open seam; E1 usage exposure
  to the UI; session/history browser.

---

## 12. Tests

`apps/renderer/tests/stage2-client.test.ts` (29 tests) — UX-01..UX-24, UX-29:
chat-first shell, Settings bottom-left, no Team/Pro/quota card, composer access position,
Tools affordance, model selector popover, UNKNOWN→`--` telemetry, known-value rendering,
canonical model seams, COMPANY policy establishment, submission success, renderer import
hygiene (never writes model/policy state), runtime panel default collapsed + canonical
 Goal/Plan/Task/Attempt/Validation projections, Role≠Model, FAILED stays FAILED, no fake
progress/ETA, no raw CoT, submission idempotency A/B/C/D, no credential values.

`apps/desktop/tests/desktop-autonomy-runner.test.ts` (7 tests) — UX-25..UX-28: immediate
start, exactly one active driver per run, approval boundary, terminal stop, restart recovery
from durable truth (terminal and non-goal runs never resumed), refusal logging, missing-driver
no-op.

`apps/desktop/tests/models-onboarding.test.ts` (8 tests) — the new read-only seams' contract:
`models.catalogue` returns the durable catalogue (and an honest empty list when no provider is
configured), `models.selection` reports "no selection" without guessing, unknown scope is
rejected, the register→policy→explain flow crosses the typed bridge only.

---

## 13. Security

contextIsolation, the sandboxed renderer and the preload allow-list are unchanged; no new IPC
channel was added (the two new operations ride the existing allow-listed
`companyos:workflow` channel). The renderer still has no Node/Electron/SQLite/provider/secrets
surface (`apps/renderer/tests/no-node-builtins.test.ts` + an import-hygiene assertion in the
Stage-2 suite). Provider credentials never leave the main process; the renderer cannot choose
its own actor (the main process stamps it). The actor, authority and model policy are only
readable, never writable, from the UI.
