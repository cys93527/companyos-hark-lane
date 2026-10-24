# DESKTOP CLIENT STAGE 3 — Authority + Approval + Settings + Artifact UX + Telemetry

Status: **Implemented** (2026-10-05). Baseline `bebd161`.
Parent: [DESKTOP_CLIENT_STAGE2.md](./DESKTOP_CLIENT_STAGE2.md).

Deliverable for `COMPANYOS DESKTOP CLIENT — STAGE 3`. The Stage-2 ChatGPT-first visual
structure is FROZEN and unchanged: this stage adds product capability, not a redesign.

---

## 1. Phase 0 verdicts (seam ownership, before any UI)

| Question | Verdict |
|---|---|
| AUTHORITY_OWNER | `decideAuthority` (packages/core/src/domain/role-authority.ts) + `createAuthorizationService` (roles/assignments, main-process only) |
| AUTHORITY_WRITE_SEAM | **ABSENT over IPC** — `defineRole`/`assign`/`revoke` are not renderer-reachable in V1 |
| APPROVAL_QUERY_SEAM | `decisions.pending` (extended in this stage with the canonical `approvals` rows) |
| APPROVAL_COMMAND_SEAM | `approval.respond` (approve → `supervisor.resumeEscalatedRun`; deny → engine `APPROVAL.DENY`) |
| PROVIDER_CONFIG_SEAM | composition-root only (trusted env configuration) |
| CREDENTIAL_SEAM | **NO renderer-reachable write seam** → `SECURE_PROVIDER_ONBOARDING_PENDING` |
| ARTIFACT_OPEN_SEAM | **ABSENT** → built here as a typed bounded main-process surface |
| E1_USAGE_SOURCE | `agent_executions.input_usage/output_usage` + `provider_dispatches` (via the new `run.usage` op) |
| CACHE_USAGE_SOURCE | **ABSENT anywhere** → always UNKNOWN |
| SPEED_SOURCE | `agent.provider_invoked` events (`outputTokens`, `latencyMs`) — the only measured model-output timing |
| COST_SOURCE | declared model pricing (`model_records.pricing`) × known usage → explicitly ESTIMATED |

Nothing was invented before its owner was located. Where a seam does not exist the stage
says so and defers, instead of creating a second truth.

---

## 2. SECTION A — Access permission (actionable where canonical, display-only where not)

The composer position is unchanged: `[ + ] [ 访问权限 ▾ ] [ 工具 ]`.

**Mode selection is DISPLAY-ONLY.** There is no canonical per-Goal/per-Run access mode —
no run-level policy field, no `commandProfile` access values, and no renderer-reachable
authority grant/revoke. The renderer therefore may NOT invent one (no localStorage
permission authority, no CSS-only safety mode, no renderer-owned permission truth). What
IS actionable is the canonical approval boundary.

| UI LABEL | CANONICAL POLICY / AUTHORITY | ALLOWED CAPABILITIES | ACTIONS STILL REQUIRING APPROVAL |
|---|---|---|---|
| 询问权限 | canonical Approval gate: `requiresHumanApproval` = risk HIGH/CRITICAL (`packages/core/src/domain/approval.ts`), run state `WAITING_APPROVAL`, blocker `APPROVAL_REQUIRED`, decision via `approval.respond` | every ordinary permitted action; the run PAUSES at the approval boundary | the escalated action itself (publish to an external system, payment, destructive external state, privilege escalation, legal commitment) |
| 只读 | canonical read authorities (`artifact.read`, `model.read`, `tool.read`, `provider.read`) vs mutation authorities (`artifact.create`, `tool.invoke`, `run.start`, …) — enforced by `decideAuthority` in Core, **below the renderer** | read / inspect / analyze / safe query | any mutation authority (the refusal is canonical, not a disabled button) |
| 工作区操作 | trusted workspace boundary: `RepositoryPathPolicy` containment (traversal, absolute, drive-qualified, UNC and `.git` writes all fail closed) | normal mutations inside the opened trusted workspace | any canonical high-risk operation, and anything outside the workspace root |

**Persistence scope: none in the renderer.** The effective mode is derived per render from
canonical run state + approval truth; nothing is persisted client-side. If a canonical
per-Goal authority-policy seam is introduced later, this is the single place to map it.

Enforcement tests (S3-03/S3-04) exercise the CANONICAL seams directly — `decideAuthority`
refusing `artifact.create` for a reader-only actor, and `RepositoryPathPolicy` rejecting
`../secrets.txt`, `E:\windows\system32\hosts`, `C:/windows/hosts` and `.git/config` — so
"read-only blocks mutation below the renderer" is proven without any UI cooperation.

---

## 3. SECTION B — Approval UX

`decisions.pending` now also returns the canonical `approvals` rows of each non-terminal run
(`id`, `riskLevel`, `status`, `reason`, `requestedBy`, `requestedAt`, `taskId`, …), read from
the durable approvals table. The client renders an approval card:

```
┌─────────────────────────────────────┐
│ 需要你的批准                         │
│ 操作：发布文件到外部系统              │
│ 风险等级：HIGH                       │
│ 范围：Run run_… · Task task_…        │
│ 请求方：agent.review                 │
│ [拒绝]                  [批准]       │
└─────────────────────────────────────┘
```

Both buttons call the ONE canonical command `approval.respond`. The renderer never resumes
the run, settles a task, forces a retry or edits blocker state — after the decision the
autonomy driver re-reads durable truth and the engine proceeds by its own semantics. A
decided row is history and is never offered again.

**Restart with a pending approval:** the approval lives in durable truth, so a remounted or
restarted client re-reads the same pending row (`decisions.pending`) and offers the same
decision. No renderer-memory dependency.

---

## 4. SECTION C — Settings (bottom-left, unchanged position)

Five sections, limited to real implemented concepts: **工作区 / 模型与提供商 / 权限与安全 /
运行与诊断 / 关于**. No subscription, team or quota advertising.

* 工作区 — current workspace + change workspace.
* 模型与提供商 — provider configured status, **authentication status as CONFIGURED /
  NOT CONFIGURED (a label, never a value)**, provider catalogue count, registered models,
  the COMPANY policy and the selected model.
* 权限与安全 — the current effective authority presentation, that it cannot be switched in
  the UI, and that high-risk operations still require canonical approval.
* 运行与诊断 — the derived readiness projection (§6).
* 关于 — CompanyOS version, Electron version, Node version, database path, schema version,
  IPC allow-list.

**Provider credential configuration: `SECURE_PROVIDER_ONBOARDING_PENDING`.** No canonical
secure credential-write seam is renderer-reachable (the `secret.write` vault is
main-process-only and in-memory; `secret_refs` has no writer), so the Settings page shows
status only and leaves provisioning to the existing trusted external configuration path
(`COS_MODEL_BASE_URL` + `COMPANYOS_MODEL_API_KEY`). No renderer secret storage, no plaintext
JSON, no SQLite key column, no localStorage secrets.

---

## 5. SECTION D — Artifact UX (bounded, main-process enforced)

New module `apps/desktop/src/artifacts.ts` + ONE typed IPC channel
(`companyos:artifacts`):

```
artifactAction({ operation: 'preview' | 'open' | 'reveal', artifactId })
```

* the artifact row must exist in the durable `artifacts` store;
* its `contentRef` must be a **managed CAS reference** (`sha256:<64 lowercase hex>`) — an
  opaque/foreign locator is refused, never dereferenced;
* the derived object path must stay inside the trusted CAS root (containment re-checked
  AFTER derivation, `<casRoot>/<2 hex>/<64 hex>` exactly), and the object must exist;
* `preview` reads bounded bytes (≤16 KiB, truncated flag) for safe kinds
  (text/markdown/csv/json, `companyos:plan`, `companyos:report`, `companyos:summary`),
  otherwise it refuses and external open is the answer;
* `open` uses `shell.openPath`, `reveal` uses `shell.showItemInFolder`.

**No `openAnyPath(string)`, no path accepted from the renderer, no generic filesystem
primitive.** S3-16/17/18 assert exactly this, including the fail-closed answers
(`ARTIFACT_NOT_FOUND`, `ARTIFACT_REF_NOT_MANAGED`, `ARTIFACT_PREVIEW_UNSUPPORTED`).

The Runtime panel's 文件 tab now offers 预览 / 打开 / 显示 per canonical artifact, and renders
the bounded preview or the typed failure inline.

---

## 6. SECTION E + I — Telemetry and readiness

New read-only control-plane operation **`run.usage`** (`apps/desktop/src/efficiency/`):

| Popover field | Semantics |
|---|---|
| Token | KNOWN input+output tokens (an observed true zero renders 0); ESTIMATED when the ledger marks it estimated |
| Usage coverage | real ratio `known / total dispatches` (`--` when there is nothing to measure) |
| Unknown dispatches | the count of work dispatches with NO usage-bearing execution — stated, so the total is never false |
| Context remaining | **UNKNOWN (`--`)** unless current-context occupancy is provable; cumulative Goal usage is explicitly NOT occupancy (S3-27) |
| Speed | `outputTokens / (single provider invocation latencyMs)` only — never attempt duration, tool time or Goal wall time |
| Cache hit | **always `--`** (no cached-token source exists anywhere in the system; never inferred from repeated commands, prompt similarity, workspace/session reuse) |
| Cost | KNOWN or explicitly labelled **ESTIMATED** = known usage × declared pricing; `--` without pricing; never a Goal total when dispatches are UNKNOWN |

A durable read failure degrades every metric to UNKNOWN with an explicit note rather than
rejecting the IPC call.

New read-only workflow operation **`runtime.readiness`** — a DERIVED projection (never a
second truth):

```
Provider:  READY / NOT_CONFIGURED / DEGRADED
Model:     READY / REQUIRED
Executor:  READY / NOT_CONFIGURED
Workspace: READY / ERROR
externalBlock: the FIRST canonical external precondition, in dependency order
```

It exists so the canonical blocker `EXECUTOR_PROVIDER_UNKNOWN` renders as
**"执行器尚未配置"** with a safe route to Settings/Diagnostics — never `undefined`, a generic
crash, or a fake failure. The smoke proves it: with a configured provider, a selected model
and no executor configured, the projection answers `EXECUTOR_PROVIDER_UNKNOWN`.

---

## 7. SECTION F/G — Tools view and runtime-panel improvements

* 工具 nav item now shows the canonical tool registry rows (tool id, enabled state, and
  — where the record carries them — risk level and required authorities) through
  `tools.list`. Informational only: it is not a substitute for planner/runtime capability
  selection, and the user never has to pick tools before autonomous work.
* Runtime panel 运行 tab now renders the canonical blockers and the pending approval
  (code, explanation, risk, reason); 详情 tab adds elapsed wall time (measured from
  canonical `createdAt`/`updatedAt`), retry counts (`attempts/maxAttempts`) and the failure
  classification — all from canonical projections. Still collapsed by default. No fake
  percentage was added.

---

## 8. SECTION J/K — No new truths

No Session Runtime, no chat-session entity, no second Authority truth, no second decision
truth. The conversation surface still derives from `goal.workspace`; the sidebar's recent
items still derive from `home.summary`. The main shell, sidebar structure, centre
conversation layout, model popover location and the runtime-panel concept are unchanged.

---

## 9. Tests

`apps/renderer/tests/stage3-client.test.ts` (37 tests) — S3-01..S3-32:
canonical effective-policy rendering, no renderer authority authorship, below-renderer
enforcement of read-only and workspace containment, high-risk still requiring canonical
approval, the approval card from canonical rows, approve/deny both crossing
`approval.respond`, autonomy pause/resume/restart semantics, Settings bottom-left + five
sections + no credential value, safe readiness rendering, explicit executor-not-configured,
artifact reveal only for canonical bounded artifacts, traversal rejection, no generic
renderer FS primitive, honest telemetry (KNOWN/UNKNOWN/coverage/speed/cache/cost and the
context-remaining rule), blocker/approval truth in the runtime panel, no raw CoT, no secret
exposure, no second Authority/Session truth.

`apps/desktop/tests/stage3-seams.test.ts` (21 tests) — the main-process halves: CAS path
containment and foreign-reference refusal, preview bounds and unsupported kinds, the E1
usage projection (coverage, measured speed, always-UNKNOWN cache, ESTIMATED cost,
degradation), the readiness projection and external-block ordering, and the
`runtime.readiness` operation contract.

`apps/desktop/tests/channels.test.ts` — the exact-match allow-list contract updated for the
ONE new bounded artifact channel (never "contains").

Full gate: `pnpm check` 6×PASS · `pnpm test:scripts` 23/23 · `git diff --check` clean.

---

## 10. Real-boot smoke (deterministic, offline)

Electron 44.5.1, fresh userData, a deterministic local provider stub (no live provider Goal),
headless rendering path on this host (its GPU fault is the recorded ENVIRONMENT defect).

Verified end to end through the real UI: workspace restore · model selector → catalogue →
UI model choice → COMPANY MANUAL policy (composer label `deepseek-v4-flash`, send enabled) ·
exactly one canonical Goal `run_01M444VMQYRYEQ2SPXBWARBXW1` · autonomy driver started exactly
once and stopped at the canonical boundary `EXECUTOR_PROVIDER_UNKNOWN` ·
`runtime.readiness` → provider READY / model READY / executor NOT_CONFIGURED ·
artifact `reveal` succeeds for the canonical artifact and `ARTIFACT_NOT_FOUND` for an
unknown id · `preview` refuses an unsupported kind (fail-closed) · the model popover shows
`上下文 128,000 · 剩余 -- · 已使用 0 · 生成速度 -- · 缓存命中 -- · 会话费用 -- · 未配置可信定价。` ·
Settings renders the five real sections with readiness rows ·
restart rehydrates the same Goal (no duplicate), the same COMPANY selection and the same
readiness · **zero unhandled rejections**.

Evidence: `E:\DeepSeek.gzq\companyos-desktop-stage1-smoke\stage2-smoke-report.json` (harness
tooling deleted after the run; dist is git-ignored).

Two real defects were caught by this smoke and fixed during the stage:
1. `run.usage` initially queried a non-existent `payload_json` column (correct: `payload`),
   and a durable read failure is now an explicit UNKNOWN degradation instead of an IPC
   rejection.
2. The readiness projection initially read the model selection through the control plane
   (where no such operation exists); it now reads the canonical policy service.

---

## 11. Known limitations (Stage-4 handoff)

* Access-mode **selection** stays display-only until a canonical per-Goal authority seam
  exists (no second authority truth may be invented).
* Provider credential onboarding remains on the trusted external configuration path
  (`SECURE_PROVIDER_ONBOARDING_PENDING`).
* Artifact `open`/`reveal` require a visible desktop session on a healthy GPU host; preview
  covers text-like kinds only.
* Cache hit is permanently `--` unless a provider/kernel cached-token source is added;
  context remaining needs a real per-invocation occupancy measurement.
* A visible non-headless Windows smoke is still required before Product V1 Freeze (recorded
  from the ENVIRONMENT GPU defect).
* No approval-required fixture exists in the deterministic smoke environment, so the
  approve/deny round trip is proven by contract tests rather than by a live approval flow.
