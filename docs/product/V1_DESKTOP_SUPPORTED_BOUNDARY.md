# V1 Desktop — Supported Boundary (Release Candidate)

Status: **Stage-4 release candidate** (2026-10-05). Head: `d9ff985` + Stage-4 commit.
Companion: [../desktop/DESKTOP_CLIENT_STAGE4.md](../desktop/DESKTOP_CLIENT_STAGE4.md).

This document states exactly what the CompanyOS desktop client supports as a V1 product
candidate, and what it deliberately does not.

---

## 1. Supported user flow (the ONE V1 loop)

1. Open CompanyOS. Select a workspace (native chooser + trusted open; persisted and
   rehydrated across restarts).
2. Choose the access policy for the next Goal (询问权限 / 只读 / 工作区操作).
3. Choose the model (canonical model registry + COMPANY selection policy).
4. Send ONE natural-language Goal.
5. CompanyOS plans (planner), compiles the plan, and executes work tasks through the
   embedded DSH kernel with the selected model. No manual 继续.
6. Observe real Task / Role / Attempt / progress in the runtime panel.
7. If a canonical approval is required, an approval card appears; approve or deny through
   `approval.respond`.
8. Receive artifacts (bounded preview / open / reveal), independent validation status, and
   the final Outcome.

No CLI, no manual database operations, and no manual task/role decisions are part of this
loop. The only user interactions are the initial Goal, the initial policy/model selection,
and a genuine canonical approval when one is produced.

---

## 2. Provider configuration boundary

The model provider is an OpenAI-compatible endpoint configured through the trusted machine
environment (`COS_MODEL_BASE_URL`, `COS_MODEL_ID`, `COS_MODEL_API_KEY`). This is the
supported V1 boundary:

* The UI shows only the status (CONFIGURED / NOT CONFIGURED) and counts — never a credential.
* There is **no secure client-side credential-write seam** in V1
  (`SECURE_PROVIDER_ONBOARDING_PENDING`); provisioning stays on the trusted
  machine/environment configuration path.
* Model registration into the canonical registry happens through the typed workflow seam
  (`models.register`) from the provider catalogue the configured adapter already published.

## 3. Executor boundary

The V1 executor is the **CompanyOS-managed embedded DSH kernel** (official pinned runtime,
materialized under the managed root; integrity closure verified per attempt). It requires
a live model route (the provider configuration above) to be constructed.

* Kernel child runtime: a real platform Node (the DSH boot gate rejects Electron-flavoured
  runtimes); the launcher resolves the platform Node from PATH and fails loud — never
  silently — if the kernel refuses the runtime.
* The kernel sandbox is workspace-bounded (`workspace-write` rooted at the trusted
  workspace); a `READ_ONLY` Goal access policy flips the kernel into its native
  `read-only` sandbox mode, so write attempts are refused by the kernel itself.

## 4. Authority modes

| Mode | Canonical meaning | Enforcement point |
|---|---|---|
| 询问权限 (default) | ordinary work proceeds; high-risk stops at the canonical approval boundary | `requiresHumanApproval` (risk HIGH/CRITICAL) → `WAITING_APPROVAL` → `approval.respond` |
| 只读 | the kernel's fs-sandbox runs in `read-only` mode; write attempts raise typed kernel errors | DSH kernel (below the renderer) |
| 工作区操作 | mutations allowed inside the trusted workspace root only; still subject to approval | `RepositoryPathPolicy` containment + canonical approval |

The policy is bound to the GOAL (run-goal artifact `structured.accessPolicy`, closed set
`ACCESS_POLICIES`), read back through `goal.workspace`, and applied per work dispatch. There
is no second authority truth; the renderer only displays canonical state.

## 5. Approval semantics

Approvals are raised only by canonical risk policy. The card shows the canonical
reason/risk/requester; both decisions cross the ONE command `approval.respond`. Pending
approvals are durable and rehydrate across restarts.

## 6. Artifact semantics

Artifacts are canonical CAS objects. Preview is bounded (≤16 KiB) for text-like kinds;
open/reveal act on the resolved CAS path inside the trusted CAS root. Unknown artifact ids,
foreign references, and traversal are refused with typed errors. There is no generic
filesystem IPC.

## 7. Telemetry semantics

KNOWN / ESTIMATED / UNKNOWN — UNKNOWN renders `--`, an observed true zero renders `0`:

* Token: KNOWN from provider usage; a coverage ratio plus the count of usage-unknown
  dispatches is shown when partial.
* Speed: KNOWN only from a single provider invocation's measured output tokens / latency.
* Cache hit: `--` — no cached-token source exists in V1 (never inferred).
* Cost: explicitly ESTIMATED = known usage × declared pricing; `--` without pricing.
* Context remaining: `--` — current-context occupancy is not measurable in V1; cumulative
  Goal usage is never presented as occupancy.

## 8. Known V1 limitations

1. **VALIDATING→COMPLETED closure for dynamically planned work** — the engine yields the
   VALIDATING transition to the evidence applicator (ADR-0020 gate); the desktop dynamic
   plan does not yet wire validators for planned work, so a completed work run can rest in
   `VALIDATING` with the Goal `EXECUTING` (typed, visible — never fabricated). This is the
   open P1 recorded at Stage 4 and routed to Boss review.
2. Access-mode *selection* is canonical and durable; arbitrary per-Goal authority
   delegation beyond the three modes is out of scope.
3. Provider credential provisioning stays on the trusted machine path (see §2).
4. Cache-hit telemetry requires a provider/kernel cached-token source (not present in V1).
5. A visible non-headless Windows smoke is REQUIRED before Product V1 Freeze
   (`VISIBLE_NON_HEADLESS_SMOKE = EXTERNAL_PENDING` on the current automation host).
6. Session & Context Runtime is deferred to V1.1 (HIGH priority); "history" derives only
   from durable Goals.

---

## 9. Restart / durability

Startup recovery + the autonomy launcher resume every non-terminal Goal run from durable
truth; a driver generation that ends in `AUTONOMY_STALLED` while the Goal run is still
non-terminal is resumed a bounded number of times (3 consecutive, 30 s cool-down) — never
for terminal, approval-bound or external-blocked outcomes. No duplicate Goals, no duplicate
task settlements: settlements are canonical engine transitions.
