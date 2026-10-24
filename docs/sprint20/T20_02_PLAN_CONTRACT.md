# T20-02 — Plan Artifact Contract & Deterministic Validator

Baseline `f073276` (T20-01 + architecture corrective). This task defines the CompanyOS plan
LANGUAGE and its deterministic validation — nothing else. No planner runtime, no provider
invocation, no WorkflowVersion compilation, no task materializer, no execution Run, no
handoff implementation, no persistence wiring.

## 1. Plan role (frozen semantics)

A Plan is a **durable planning specification stored as an immutable Artifact owned by the
Planning Run** (T20-01 §21 Shape B). It is NOT execution truth — not Workflow/Task/Decision/
Validation/Approval/Scheduler state; those authorities stay with WorkflowVersion, Run, Task,
Decision, Review and Validation. **A Plan has NO state machine** (no DRAFT/APPROVED/RUNNING/
DONE/FAILED/SUPERSEDED); the artifact content is immutable, approval belongs to external
authority, execution lifecycle belongs to the existing runtime. There is no mutable plan
version counter: one immutable Plan Artifact = one validated planning result; re-planning =
a new permanent planning command ⇒ a new plan identity/artifact (the existing immutable
artifact convention).

- **Artifact kind:** `companyos:plan` ｜ **Trusted payload schema:** `companyos/plan/1`
  (repo convention, `companyos:run-goal` / `companyos:review-findings` precedent).
- **No new table, no migration.** The future artifact ride the existing ArtifactService.

## 2. PlanningProposal ≠ trusted Plan (§5)

| | `PlanningProposal` (model output) | `PlanArtifactPayload` (trusted) |
| --- | --- | --- |
| schema | `companyos/plan-proposal/1` | `companyos/plan/1` |
| content | items + criteria ONLY | + `sourceGoal.goalArtifactId` |
| identity | none | planId / fingerprint (trusted-derived) |

The model can NEVER supply planId, artifactId, planningRunId, companyId, commandId,
fingerprint, createdAt, approval, WorkflowVersionId or TaskId — none of those fields exist
in the proposal shape; every one is decided by the trusted runtime/service.

## 3. Identity & fingerprint (§6/§7)

- `planId = pla_<sha256("companyos/plan/1:" + companyId + ":" + planningRunId + ":" + planningCommandId)[0:26]>`
  — the decision-sink/corrective-provisioner convention. Deterministic from the trusted
  planning scope ONLY: no model output, timestamps, randomness, provider/model/artifact ids
  or plan content. Same scope + same command ⇒ ALWAYS the same planId (test 1-5).
- `planFingerprint = sha256Hex(canonicalJson(payload))` over the VALIDATED payload — stable
  planning semantics only; the schema has no timestamp/usage/provider fields at all, and
  any attempt to add one is rejected as an unknown field (test 10).
- `comparePlanFingerprint({recorded, candidate})` → `REPLAY` | `CONFLICT` — the primitive a
  future runtime uses: same permanent command + same fingerprint = replay; different
  fingerprint = CONFLICT, fail closed (test 11). T20-02 ships the primitives; the durable
  replay sink belongs to the future planning service.

## 4. Contract shape (§9/§11–§14/§17/§18)

```text
PlanningProposal {
  schema: 'companyos/plan-proposal/1'
  planItems: [{ planItemId, objective,
                dependencyPlanItemIds?, acceptanceCriterionRefs? }]   // 1..64
  acceptanceCriteria: [{ criterionId, requirement }]                  // 1..128
}
PlanArtifactPayload { schema, sourceGoal: { goalArtifactId }, …same content… }
```

- `planItemId` / `criterionId`: PLAN-LOCAL stable ids, `[a-z][a-z0-9-]{0,62}` — NOT TaskIds
  and NOT workflow node ids (any deterministic derivation is a T20-05 compiler decision).
- `objective` / `requirement`: bounded text (2 000 chars). Criteria are SPECIFICATION
  ("what counts as done") — no PASS/FAIL/status/verdict/state fields exist.
- Dependencies are **compiler input only**, never runtime dependency truth; the future
  chain is Plan deps → T20-05 compiler → WorkflowVersion stage DAG.
- **`requestedWorkKind` and `requestedValidatorIds` are DELIBERATELY ABSENT** (§17/§18
  ruling): today's execution role is decided by node `kind` → trusted composition handler
  registration (T19-04 recon), and a V1 compiler can deterministically derive every plan
  item's work node from a fixed trusted pattern (work node per item + the standard
  review/qa chain), while validator authority comes from the pinned trusted policy. No
  field is added "to look complete"; if the compiler later proves a need, a new schema
  revision adds it.

## 5. Validation rules (§12/§14/§21–§25)

Structural validation (`validatePlanningProposal` / `validatePlanArtifactPayload`, Core,
zero persistence): unknown schema, malformed payloads, missing fields, wrong types,
duplicate item/criterion ids, unknown/duplicate/self dependency refs, cycles, unknown or
duplicate criterion refs, empty or oversized text, invalid id syntax — ALL fail closed with
explicit `PLAN_*` reasons. **Unknown Field Policy = FAIL CLOSED** (`PLAN_UNKNOWN_FIELD`) at
every level (proposal / item / criterion / sourceGoal): nothing that could change planning
semantics is silently ignored. **No semantic auto-repair exists** — no cycle removal, id
renaming, ref dropping, criterion invention, dependency guessing or objective rewriting; an
invalid model proposal fails closed, and a fix is the next independent authorized planning
attempt. Validation is fully deterministic (no LLM/network/clock/randomness; repeated
validation of the same input is byte-identical — test 40), and the normalized output is
deterministic (empty optional collections normalize to the canonical absent form).

**Dependency graph**: refs must exist, no self-refs, no duplicate refs, acyclic
(iterative coloring); **multiple roots are allowed** — matching the existing
WorkflowVersion DAG contract, which allows multiple entry stages. **No task dependency
table/column/authority was added** (TASK_DEPENDENCIES = stage DAG authority).

**Unreferenced-criteria rule (§15, frozen)**: a criterion no plan item references is
**REJECTED** (`PLAN_CRITERION_UNREFERENCED`) — V1 has no global-criteria requirement and the
schema stays minimal.

### Contract corrective (Boss review of T20-02)

- **EVERY_EXECUTABLE_PLAN_ITEM_HAS_ACCEPTANCE_CRITERIA (corrective §1/§2)**: every plan item
  MUST reference ≥1 criterion — absent AND empty `acceptanceCriterionRefs` both fail closed
  with `PLAN_ITEM_CRITERIA_REQUIRED`. There is NO synthetic default criterion anywhere
  ("task completed" / "implementation works" / "passes validation" do not exist): missing
  criteria are never repaired. The final V1 invariant is TWO-SIDED: every item → ≥1
  criterion; every criterion → ≥1 item.
- **Shared criteria (corrective §3/§4)**: ALLOWED. A criterion is an IMMUTABLE REUSABLE
  REQUIREMENT REFERENCE — many items may cite the same criterion; no criterion ownership
  state exists (and none may be created); evaluation stays TASK-SCOPED downstream (a
  criterion never carries status; the future compiler preserves the reference into version
  node config and Task refs, and Reviewer/QA judge each Task against the cited definitions
  — task lifecycle is never conflated). No `PLAN_SHARED_CRITERION_SCOPE_GAP` exists.
- **ID bound consistency (corrective §5/§6)**: the ONE canonical bound is **64** (the repo
  convention — review-findings `maxCodeChars: 64`); the id regex is
  `[a-z][a-z0-9-]{0,63}` (total length 1..64), agreeing exactly with
  `PLAN_LIMITS.planItemIdMaxLength` / `criterionIdMaxLength` (both 64), the validator
  checks, this document and the boundary tests (which derive lengths from `PLAN_LIMITS`,
  never from the regex).
- **Nonblank semantic text (corrective §8/§9)**: `objective` and `requirement` must be
  NONBLANK — `""`, `"   "`, `"
	"` and Unicode-whitespace-only input are ALL rejected
  (the blank check is Unicode-aware). This is a rejection check only: accepted text is
  stored and fingerprinted AS WRITTEN — there is deliberately NO trim normalization, so
  `"  implement API  "` and `"implement API"` are two DIFFERENT valid plans with different
  fingerprints; the fingerprint hashes the validated canonical representation (the original
  text), deterministically.

## 6. Authoritative reference validation (§10/§30)

`createPlanReferenceValidator` (engine `planning/plan-reference-validator.ts`) is READ-ONLY
and checks only facts that already exist: planning Run exists and belongs to the company
(NOT_FOUND / no-leak for foreign tenants), the run's canonical goal artifact exists
(looked up by its permanent `run-goal:<runId>` creation command), has kind
`companyos:run-goal`, belongs to the planning run, and the plan's `sourceGoal` names it.
It never validates a future WorkflowVersion/Execution Run/Task — they do not exist yet.
Structural validation (Core) performs no persistence lookups — the two validators are
deliberately separate seams.

## 7. Bounds (§20)

`PLAN_LIMITS` (fail-closed, no silent truncation): items 1–64; criteria 1–128; dependency
refs ≤16/item; criterion refs ≤16/item; ids ≤64 chars; objective/criterion text ≤2 000
chars. Every bound accepts exactly its maximum and rejects one more (tests 26–33).

## 8. Authority separation (§19/§26–§29/§31–§33)

- The contract cannot create Tasks, publish WorkflowVersions, create Runs, write Decisions,
  grant validator or tool authority, or change Session/Handoff state — PROVEN structurally:
  the Core module imports ONLY kernel primitives; import-surface assertions (tests 46–52)
  pin that no execution seam can appear unnoticed.
- Future write authority (frozen, §26): Model → PlanningProposal → trusted Planner Runtime
  (validator) → trusted Planning Service → ArtifactService writes the Plan Artifact. The
  model never calls ArtifactService, never decides artifact identity, never writes the
  canonical plan.
- Provider-neutral (no provider/conversation/thread ids anywhere) and session/handoff-free
  (no sessionId/residue/transcript/handoff fields — planning and Developer Session are
  different lifecycles; handoff truth never depends on plan truth).
- Plan never drives the engine: Plan → deterministic compiler → WorkflowVersion → Run →
  Task → Engine is the only legal chain.

## 9. Future seams this contract prepares (§43)

- **Normal-task materializer (T20-03):** consumes pinned WorkflowVersions; plan items map
  to tasks only THROUGH a compiled version — the contract's planItemIds/criterion refs are
  the future compiler's inputs.
- **Planner runtime (T20-04):** emits `PlanningProposal` (schema-pinned, structured-only);
  the trusted runtime adds identity + source goal and persists via the planning service.
- **Compiler (T20-05):** deterministically maps plan items + dependency DAG + criteria to
  a published version's nodes/edges/node-config criteria, then the execution Run and
  provisioner-shaped task materialization (timing C).

## 10. Gap board after T20-02

PLAN_CONTRACT / PLAN_VALIDATION / PLAN_IDENTITY / PLAN_FINGERPRINT = CLOSED;
PLAN_DURABILITY = CONTRACT CLOSED / RUNTIME WRITE OPEN; PLAN_VERSIONING = IMMUTABLE
ARTIFACT SEMANTICS CLOSED; PLAN_IDEMPOTENCY = PRIMITIVES CLOSED / RUNTIME REPLAY OPEN;
PLANNING_RUNTIME / GOAL_TO_PLAN / PLAN_TO_WORKFLOW / PLAN_TO_TASK = OPEN (T20-03..05);
TASK_DEPENDENCIES = NOT_REQUIRED FOR V1 (stage DAG authority); ACCEPTANCE_CRITERIA = PLAN
CONTRACT CLOSED / WORKFLOW FREEZE OPEN (T20-05); PLAN_APPROVAL = OPEN (external authority,
no contract status); WORK_PACKAGE_PROJECTION = PARTIAL (unchanged).
