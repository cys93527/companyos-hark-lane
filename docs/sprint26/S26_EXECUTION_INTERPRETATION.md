# Sprint26 — Execution Interpretation (written BEFORE implementation, per §0)

Baseline `b5369be` (Sprint25 PASS/FULLY CLOSED/FROZEN), working tree clean. This document
records the ten required statements and the load-bearing facts they rest on (probed from
the repository, not assumed). One ambiguity was identified and resolved by OMISSION (§S6,
pause), everything else maps onto existing canonical surfaces. No STOP condition fires.

## S1 — What "Product Control Plane" means in CompanyOS

A **desktop application surface** — one new schema-validated IPC channel, one trusted
main-process application service, and a renderer UI — that lets a user express a Goal,
start/continue the EXISTING Goal→Outcome pipeline, see truthful state, and perform only
legitimate high-level control actions. It is a **consumer and command forwarder**: it owns
no truth, holds no second state, and every mutation it forwards already has a canonical
owner. The pipeline itself already exists end-to-end (Sprint 18–25): run-owned Goal →
NormalTaskMaterializer → PlannerRuntime (Plan artifact) → PlanCompiler (published version +
execution run + tasks) → AutonomousSupervisor (bounded turns) → engine claim/preflight/
provider/settlement → Validation/Findings → Handoff. Sprint26 wires a human-facing entry
and window onto it. It is NOT a new runtime.

## S2 — The user workflow this sprint must make usable

Home ("你想把什么事情变成现实？") → the user types intent → `goal.create` creates the
canonical planning run WITH the goal (one lifecycle transaction, idempotent by command id)
→ `goal.advance` performs bounded canonical pipeline steps (planning turn → trusted spec
derivation → compile → supervisor turns on the execution run) → Goal Workspace shows goal,
phase, plan, runs, current activity, blockers, pending decisions, results → Run View shows
the Sprint23 observation of any run → Pending Decisions lists approval/decision blockers
with allowed responses → `approval.respond` travels the canonical mechanism → Artifacts/
Evidence/Handoff views show canonical references. Restart reconstructs everything from
durable state. The user never creates Task/Agent/DAG/Attempt/Session objects (§3).

## S3 — Canonical owners that must remain unchanged

WorkflowVersion (pinned semantics) · WorkflowTemplate/lineage · Run · Task ·
ExecutionAttempt · AgentExecution · Artifact/CAS · Validation · Finding · Handoff
(HandoffService sole owner) · Decision/Approval (engine + DecisionService) · the run-owned
Goal artifact (RunGoalService; there is deliberately NO Goal table) ·
RunObservationService (read-only projection) · the supervisor's bounded-turn authority ·
the Sprint25 safety preflight. The Control Plane adds ZERO new durable domain truth.

## S4 — Renderer / main / application authority boundaries

- **Renderer is untrusted.** It may: request read projections, submit typed operation+
  payload requests, receive non-authoritative "something changed" signals. It must never
  import persistence/SQLite/provider adapters or hold domain truth. The existing repo
  pattern is preserved and hardened: one channel per concern (`companyos:control-plane`),
  schema-validated server side (channels.ts allowlist + preload mirror + drift test), no
  generic executeSQL/readFile/spawn bridges.
- **Desktop main is the trusted application layer.** A new `control-plane.ts` service (in
  `apps/desktop/src/`, composition tier) validates schema, proves company scope and
  run/goal ownership for every request, applies revision/precondition checks, then calls
  ONLY canonical services: `lifecycle`, `sprint13.engine`, `plannerRuntime`,
  `normalTaskMaterializer`, `planCompiler`, `autonomousSupervisor`, `runObservation`,
  `handoff`, `decision`, `supervisorDecisionSink`.
- **Engine/domain services stay the only writers.** UI failure can never mutate workflow
  state (§42): the renderer crashing is a projection problem, not a domain event.

## S5 — Expected production modules

- `apps/desktop/src/control-plane.ts` (NEW): the trusted application service — command
  handlers (goal.create / goal.advance / approval.respond / run.read.* projections) with
  company scoping, idempotency and revision preconditions; a read-only Goal Workspace
  projection derived from canonical sources (planning run + compilation anchors +
  RunObservationService).
- `apps/desktop/src/channels.ts` + `preload/preload.cjs` (+ its drift test): ONE new
  channel `companyos:control-plane`; `main.ts` registers the handler.
- `apps/renderer/src/`: `home.tsx` (goal entry), `workspace.tsx` (goal workspace + run
  view + decisions + artifacts via ONE bridge), `bridge.ts` extension. No state library
  (§61): local component state + re-read on signal.
- `tests/sprint26/*`: contract, IPC-boundary, decision-action, restart/live-refresh,
  renderer-boundary suites + real DSH control-plane smoke.
- Docs: `S26_PRODUCT_CONTROL_PLANE.md` (with the action matrix), REFERENCE_CAPABILITY_MAP,
  EXECUTOR_PROTOCOL rules, INDEX rows.

## S6 — Actions the UI may invoke (and only these)

Every action must name a canonical owner (action matrix in the main doc):
1. `goal.create {companyId, commandId, objective}` — lifecycle.createRun over the trusted
   default planning workflow (provisioned once by the composition through the normal
   create/publish lifecycle, deterministic identity); the goal rides the run-creation
   transaction. Idempotent by commandId (duplicate = original run, never a second goal).
2. `goal.advance {companyId, runId, actorId?}` — ONE bounded canonical step of the
   pipeline for that goal's planning run (planning turn → derive the COMPLETE explicit
   per-item spec from the durable validated plan through a trusted deterministic
   application rule → compile → hand the execution run to the supervisor's bounded turn
   where one applies). Bounded, idempotent per canonical replays, honest typed outcome.
3. `approval.respond {companyId, runId, decision: approve|deny, note?}` — the canonical
   approval mechanism (engine APPROVAL.GRANT/DENY semantics via the supervisor's trusted
   resume seam for escalated runs, and the supervisor decision surfaces for decision
   blockers).
4. Reads: `home.summary`, `goal.workspace`, `run.observation` (overview/blockers/timeline/
   task), `run.artifacts`, `run.handoff`, `decisions.pending` — all read-only projections.

**Omitted (§12B):** run PAUSE as a UI button — the engine's RUN.PAUSE exists but no
application-level pause-for-user surface with pause-owner semantics is exposed by any
existing service; rather than invent one, V1 omits it and documents why (the main doc's
action matrix). Cancel/stop likewise omitted (no canonical user-cancel application
command). Provider selection, workspace change, secret anything: never UI actions.

## S7 — Actions the UI may NEVER perform directly

Open SQLite · write repositories · Task/Run state changes · settle ExecutionAttempt ·
resolve Findings · pass Validations · create Handoff truth · choose Provider · change the
trusted workspace · read any secret value · spawn processes · receive provider child
environments · generic file/SQL bridges. Each gets a negative contract test.

## S8 — External reference mechanisms being adapted

**Paperclip — SELECTIVE COMPANYOS-NATIVE ADAPTATION** (per REFERENCE_ADOPTION_POLICY):
operational control surface → Goal Workspace + Run Control Plane (ADAPT); runtime status →
RunObservationService (ADAPT, already built); explicit human approvals → existing
Decision/Approval authority (ADAPT); cost/budget → **DEFER** (canonical per-execution token
usage exists in AgentExecution provenance, but no canonical budget/cost aggregation truth —
no fake estimates); AI employee org-chart authority / Paperclip Task/Workflow/Agent truth →
**REJECT**. **DeepSeek Harness** (§31): durable-vs-live separation, diagnostics-only
provider/session visibility (already the Sprint24 stance). No Paperclip runtime, no
Cordis, no new platform (§61).

## S9 — STOP conditions

`S26_NO_CANONICAL_COMMAND` — a needed UI action has no canonical owner and no smallest
proper application command can reuse existing authority (then: omit + document) ·
`S26_RENDERER_AUTHORITY_LEAK` — a required feature would need renderer-side persistence/
provider/domain imports (STOP; redesign) · `S26_SECOND_TRUTH` — implementation would need a
new durable dashboard/goal-workspace/ui-state table (STOP; the projection must be
rebuildable) · `S26_PIPELINE_SEMANTICS_AMBIGUOUS` — the goal.advance chain would have to
invent new pipeline semantics rather than sequence existing ones (STOP; ask) · ambiguity
anywhere → STOP, never guess Boss product semantics.

## S10 — Definition of success

The §44 ten-step flow runs through production boundaries (typed IPC → application service
→ canonical services → engine → real or scripted provider → settlement → observation →
UI), with the §53 thirty contract points each having real independent evidence (boundary
negative tests included), the §46–§52 flows (decision, uncertain, multi-blocker, restart,
lost-signal, double-submit, stale revision) proven, a real DSH control-plane smoke 3/3, the
architecture guard extended with the renderer-trust laws (both-direction probes), all
Sprint18–25 regressions green, full suite ≥208 files/≥2640 passing/0 required skips, five
suites 5/5, `pnpm check` 5 consecutive, scripts 23/23 — and the Boss's §69 source audit
answering NO to every shadow-truth question.

## Resolved ambiguities (recorded, not guessed)

1. **"Goal" identity**: CompanyOS has no Goal table by frozen design (T18-02): the goal
   is a run-owned immutable artifact, and the compiled execution run's goal is semantically
   identical with `sourceRef: plan:<planId>` provenance (T20-05). Therefore the V1 product
   "Goal" = the planning run + its goal artifact, and the Goal Workspace groups the
   execution runs derived from it via the durable plan-compilation anchors. No new truth.
2. **Plan compilation spec**: Core forbids implicit default profiles; the spec must be
   explicit and complete. V1 derives it in the trusted application layer from the durable
   validated plan (every item → the deployment's generic work profile), deterministically,
   never from model text. Pack-specific profiles are the future Pack seam (§38).
3. **Pause/cancel buttons**: omitted (S6) — no canonical user-pause/cancel application
   command exists; documented rather than invented.
4. **Live updates**: reuse the Sprint23 notifier rule (signal ≠ truth; refresh re-reads).
