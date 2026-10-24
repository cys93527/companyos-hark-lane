# Sprint26 — Product Control Plane (FROZEN candidate)

Baseline `b5369be` (Sprint25 frozen). Interpretation-first: `S26_EXECUTION_INTERPRETATION.md`
was written before any production change.

## 0. Provider-agnostic ruling (V2 closeout)

The Product Control Plane is **NOT a DeepSeek Harness control product**. DSH is ONE
ExecutorProvider implementation and one external reference — never product authority and
never a Sprint26 canonical dependency. Sprint24 already proved the real external provider
path (canonical runtime → production ExecutorProvider → real DSH → canonical settlement);
Sprint26 proves the product control surface drives the canonical runtime through the
GENERIC provider seam. The required E2E therefore uses a deterministic provider
implementation registered through the SAME `ExecutorProviderRegistry`, invoked after the
SAME Sprint25 preflight and settled by the SAME engine path (3 consecutive PASS + a
provider-swap proof). Local DSH availability is an OPTIONAL compatibility probe
(`PASS/FAIL/TIMEOUT/NOT_RUN`, non-blocking): the recent local slowness is classified as
EXTERNAL_PROVIDER_AVAILABILITY_DIAGNOSTIC. Latest-official-DSH research is a separate
backlog task (LATEST_DEEPSEEK_HARNESS_ARCHITECTURE_RECON), not Sprint26 work.

**Stub matrix (what the E2E's controlled fixtures may bypass: NOTHING canonical):**
planner/review/qa model answers = CONTROLLED FIXTURE at the ModelProviderPort seam (the
deterministic Plan/decision inputs needed to reach the scenario; the planner turn still
runs PlannerRuntime's own validation); deterministic ExecutorProvider = CONTROLLED FIXTURE
implementing the same contract in the same registry after the same preflight; trusted
workspace root = a real temp directory through the trusted-host seam. NOT stubbed:
control-plane command authority, Task, ExecutionAttempt, preflight, provider registry,
provider contract, settlement, observation.

## 1. Product mission & positioning

CompanyOS is the AI-native general-purpose **Goal-to-Outcome execution operating system**.
Sprint26 delivers the minimum trustworthy V1 **Product Control Plane**: a Goal-first desktop
surface over the EXISTING pipeline (run-owned Goal → PlannerRuntime → PlanCompiler →
AutonomousSupervisor → engine claim/preflight/provider/settlement → Validation → Handoff).
It is NOT an IDE, a Jira clone, a chat room, or an org-chart product; software development
stays a Pack. The entry question is “你想把什么事情变成现实？” — the user never creates
Task/Agent/DAG/Attempt/Session objects.

## 2. Information architecture

Home (goal entry + goal list) · Goal Workspace (goal, phase, plan, execution runs,
blockers, decisions, results) · Run View (Sprint23 observation: state, pinned version,
task counts, attempts, provider identity/status, blockers, timeline) · Pending Decisions
(canonical blockers with allowed responses) · Artifacts (canonical references + safe
metadata). No competing product truths (§4 of the contract).

## 3. Read model

Reads are `RunObservationService` passthroughs plus a thin derived Goal Workspace
projection (planning run + `executionRunIdOf`-derived execution runs confirmed against
durable rows). Read-only, fully rebuildable, never necessary for workflow correctness. No
`dashboard_state`/`ui_run_state`/`ui_pending_decisions` tables exist (probed).

## 4. Command boundary & action matrix

Renderer → preload bridge (`controlPlaneRequest`, ONE channel `companyos:control-plane`)
→ trusted `control-plane.ts` service (schema + company + ownership + revision validation,
fail closed) → canonical services only.

| UI Action | Canonical Command Owner | Allowed Source State | Revision/Precondition | Durable Result | Idempotency | Failure Codes |
|---|---|---|---|---|---|---|
| goal.create | lifecycle.createRun (+ trusted planning-workflow provisioning, deterministic name) | model selected for the company | commandId (ledger replay) | planning Run + run-owned goal artifact | same commandId ⇒ same run | MODEL_SELECTION_REQUIRED, CONTROL_PLANE_CROSS_COMPANY_REFUSED, INVALID_ARGUMENT |
| goal.advance | PlannerRuntime → PlanCompiler → engine.drive → AutonomousSupervisor.run | run exists in active company | deterministic planning/compile command ids; compile anchor fingerprint | Plan artifact, published version, execution run, bounded supervisor turn | replays; same-command different-semantics CONFLICTS | typed pipeline errors incl. PLAN_UNKNOWN_FIELD, CONTROL_PLANE_MODEL_UNSELECTED |
| approval.respond (approve) | supervisor.resumeEscalatedRun (engine APPROVAL.GRANT) | run WAITING_APPROVAL | expectedRevision via the seam | resumed run | `supervisor-resume:<run>:<rev>` deterministic | AUTONOMOUS_RESUME_NOT_WAITING |
| approval.respond (deny) | engine APPROVAL.DENY (authority from the trusted caller, as the resume seam does) | run WAITING_APPROVAL | expectedRevision | denied approval, run state per engine | `control-plane-deny:<run>:<rev>` deterministic (double deny = duplicate) | PERMISSION_DENIED, CONFLICT (stale) |
| run.pause / cancel | **OMITTED** — no canonical user-pause/cancel application command exists; documented, not invented | — | — | — | — | — |
| provider choice / workspace change / secret anything | **NEVER a UI action** | — | — | — | — | — |

## 5. Renderer trust boundary

The renderer may request projections, submit typed commands, receive non-authoritative
signals. It never opens SQLite, imports persistence/engine/provider code (ARCH-035), never
mutates domain state, and no control-plane response carries secrets or provider
environments (probed). Buttons disable while a canonical mutation is pending.

## 6. Stale UI / duplicates / restart / live signal

Revision preconditions on approval commands (stale = typed conflict, loud) · deterministic
command ids (double click = replay or typed conflict, never a duplicate goal/decision) ·
restart reconstructs everything from SQLite (proven) · live signal = “re-read the
projection” (Sprint23 rule; loss recoverable, probed).

## 7. Uncertain outcome UX

UNCERTAIN stays UNCERTAIN: never rendered as FAILED/RETRYING/SUCCESS, never silently
retried, session continuation never labeled recovery. The blocker list renders each typed
code with its message.

## 8. Provider visibility

providerKey/dispatchKey (diagnostics), providerSessionId, providerInvocationId only when
supported, honest recovery triple (continuation true, same-invocation recovery false for
the local runtime).

## 9. Error model

Typed errors stay typed through the UI (`CONTROL_PLANE_*`, `MODEL_SELECTION_REQUIRED`,
`SECRET_NOT_FOUND`, `EXECUTOR_CONFIG_DRIFT`, …). A control-plane failure never mutates
workflow state (structural: reads have no write seam; probed).

## 10. Pack extension seam

The trusted `goalWorkProfile` composition option is the V1 seam for Pack-specific work
profiles; Core UI owns the generic objects. No per-industry forks.

## 11. Known V1 limitations

1. Pause/cancel omitted (no canonical application command).
2. `goal.advance` is bounded per call; long pipelines need repeated advances (the honest
   bounded-turn discipline — no hidden autonomous loop).
3. The real local harness (dsh) executes slowly in a COLD workspace cwd (multi-minute
   first-turn initialization); the smoke uses the harness's own runtime directory as the
   trusted workspace and this limitation is recorded, not hidden.
4. Cost/budget display DEFERRED (no canonical budget truth; no fake estimates).
5. Single active company (`company_default`); cross-company access fails closed by proof.

## 12. Tests

`tests/sprint26/`: control-plane flow (5) · renderer boundary (5) · decisions/restart/
signal/concurrency (6) · provider-agnostic production-path E2E (3 consecutive PASS + the
provider-swap proof, `s26-provider-agnostic-e2e.test.ts`) · architecture probes for
ARCH-035/036 (both directions). Local DSH compatibility probe: OPTIONAL, informational.
All Sprint18–25 suites unchanged and green.
