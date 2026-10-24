# EXECUTOR PROTOCOL (development-process document — not product runtime truth)

The frozen Boss→Executor protocol for CompanyOS sprint execution.

## Task Contract
Each Boss order is a numbered Task Contract: mission, frozen baseline, canonical
owners, STOP conditions, acceptance tests, gates, commit message. The executor
reads the ENTIRE contract before any production change.

## Interpretation
Before implementation the executor writes a sprint interpretation document
(what is being solved, owners that must not change, modules to touch, what will
NOT be built, adapted references, STOP conditions, success definition) and
compares it against the contract.

**AMBIGUITY → STOP. Never AMBIGUITY → GUESS.** Architectural semantics are
never inferred; a material ambiguity halts work until Boss clarifies.

## Allowed Scope
Only what the contract names: production modules, tests, docs, guard wiring.
Reference mechanisms are adapted only through explicit CompanyOS-native specs
(`docs/references/REFERENCE_ADOPTION_POLICY.md`).

## Forbidden Scope
Second Task/ExecutionAttempt/scheduler/DAG/queue truths; workflow authority in
registries or providers; silent capability degradation; universal exactly-once
claims; secrets persistence; GUI automation; vendor Core; speculative
architecture. Frozen Sprint semantics are never amended to make work easier.

## Canonical Owners
WorkflowVersion (pinned semantics) · Run (lifecycle) · Task (work lifecycle) ·
ExecutionAttempt (attempt identity/recovery/settlement) · AgentExecution (model
provenance) · Artifact/Evidence/Validation/Finding (their truths) ·
HandoffService (sole handoff owner) · RunObservationService (read-only) ·
ExecutorProviderRegistry (implementation discovery only).

## Reference Adoption
Every external mechanism: Source Mechanism → CompanyOS Mapping → Decision
(ADOPT/ADAPT/COMBINE/DEFER/REJECT) → Forbidden Copy → Acceptance Test, recorded
in `docs/references/REFERENCE_CAPABILITY_MAP.md`. Nothing is marked adopted that
was not implemented.

## Acceptance Tests
The contract's numbered tests exist independently; no count gaming; the frozen
baseline counts never shrink; architecture guards pass; real integrations run
for real (a mock never closes a real-provider sprint).

## STOP Conditions
`SPRINT{n}_BASELINE_ARCHITECTURE_DEFECT` (a frozen boundary proves defective) ·
`SPRINT{n}_REAL_PROVIDER_RUNTIME_UNAVAILABLE` (no stable local automation
interface) · `SPRINT{n}_SECRETS_PREREQUISITE_BLOCKED` (missing secret facility)
· any material ambiguity. STOP reports carry: candidates discovered,
interfaces checked, what is missing, minimum user action.

## Evidence Report
The final report returns the contract's template verbatim, with real numbers:
test files/passing/skips, stability ×5, real smoke ×3, guard PASS, sprint
regressions PASS, commit hash, working-tree state — honest failures declared,
never faked.

## Terminology Equivalence (permanent rule)
TERMINOLOGY EQUIVALENCE MUST BE PROVEN. Similar names across external systems are never
mapped onto CompanyOS canonical concepts merely because they sound equivalent. In particular:
Session ≠ Run · Provider Run ≠ CompanyOS Run · Turn ≠ ExecutionAttempt · Continuation ≠
Same-Invocation Recovery · Provider success ≠ Task settlement · Provider Session ID ≠
Provider Invocation ID.

## Decision Provenance (permanent rule)
Every recorded constraint carries its true source: USER CONSTRAINT (a real-world constraint
explicitly supplied by the user) · BOSS ARCHITECTURE DECISION (a CompanyOS design ruling) ·
EXECUTOR DISCOVERY (a fact established by the executor from repository/runtime evidence).
One source is never rewritten as another. Example: the Sprint24 provider target is a
USER-SPECIFIED LOCAL RUNTIME CONSTRAINT — the installed DeepSeek Harness
(`E:\DeepSeek.Harness`, dsh 0.1.6-max, not the newest official version) is the actual
production validation target, so capability and recovery semantics are determined ONLY
from this local runtime's verified behavior.

## Secret values are never evidence (permanent rule, Sprint 25)
SECRET VALUES ARE NEVER EVIDENCE. A `SecretRef` is a pointer: which credential is needed
and where it comes from. It may be persisted, logged, projected and carried in evidence.
A resolved value is process memory for exactly one caller and never reaches a durable
object, an artifact, an event, a log line or an error detail — and when a payload refuses
to travel because material was found inside it, the refusal reports a length bucket, never
the value. An unconfigured secret is `SECRET_NOT_FOUND`; an unreachable source is
`SECRET_SOURCE_UNAVAILABLE`. Neither ever degrades into an empty string, a placeholder or
a "best effort" continuation, and neither is ever reported as `PERMISSION_DENIED`, because
the operator's remedy differs.

## Unverified workspace is no execution (permanent rule, Sprint 25)
UNVERIFIED WORKSPACE = NO EXECUTION. A provider child process is created only in a
directory the system proved, at the instant of the decision, to be the trusted workspace
root or inside it — by a path COMPONENT boundary (never a raw string prefix), with
normalization applied before the comparison, and with reparse/symlink escapes refused. The
trusted root is an application-supplied value: never a model, a provider, a provider's
stdout or a task payload. A requested cwd that arrives without the trusted root it was
derived from is refused, because an unverifiable request cwd is an unverified workspace.

## Safety failure is fail closed (permanent rule, Sprint 25)
SAFETY FAILURE = FAIL CLOSED. The ordered precondition — configuration valid → secret refs
resolvable → workspace trusted → cwd allowed → capabilities supported → authorization
present — occurs AFTER the canonical CompanyOS ExecutionAttempt claim is durably committed
(Transaction A: Task → RUNNING, ExecutionAttempt → ACTIVE, attempts += 1) and BEFORE any
provider-side dispatch/publication or external side effect (the subordinate
provider_dispatches row is written only after the preflight passes, and the provider is
invoked outside any SQLite write transaction). A failure is a typed verdict (stage +
reason) delivered as an ORDINARY failed outcome that the engine settles through the
existing transactions, consuming its attempt under the frozen retry semantics. There is no
second lifecycle, no SafetyAttempt, and no "continue anyway" path.

## Safety restrictions may not silently weaken (permanent rule, Sprint 25)
SAFETY RESTRICTIONS MAY NOT SILENTLY WEAKEN. A declared configuration value is honored, not
overridden by a guess (`fallbackCwd` is honored, never replaced by a nearby directory). The
child environment is built by the allowlist policy, never by inheriting the parent
wholesale. A most-recently-validated boundary is re-validated per spawn rather than cached
once. Anything that would relax a boundary needs an authorization with real provenance —
the existing Decision/Approval mechanism — never an ad-hoc boolean, and when no such
mechanism exists the capability is not built.

## Config provenance must be traceable (permanent rule, Sprint 25)
CONFIG SOURCE / DECISION PROVENANCE MUST BE TRACEABLE. Every effective provider
configuration value records the source that produced it (composition → named environment
variable → declared default), and a frozen ExecutionAttempt records the fingerprint of the
configuration it was claimed under. A resumed attempt compares against that fingerprint
instead of reading whatever the environment says now; a drifted resume fails closed rather
than substituting. A binding with no recorded fingerprint has UNKNOWN provenance, which is
reported as unknown — never as "matched".

## Product Control Plane rules (permanent, Sprint 26)
Two V2 additions: PROVIDER AVAILABILITY IS NOT CONTROL-PLANE TRUTH — an external executor
being slow or down is an availability diagnostic, never a product-correctness verdict; the
product control surface is proven against the generic provider seam with deterministic
conforming implementations. PRODUCT SEMANTICS MUST NOT DEPEND ON ONE PROVIDER — no
provider name, workflow or shortcut may branch Goal/Run/Task/ExecutionAttempt/Observation
semantics; EXTERNAL REFERENCE != PRODUCT DEPENDENCY.
UI LABELS MUST NOT REDEFINE DOMAIN SEMANTICS. A BUTTON IS NOT AUTHORITY. A RENDERER STATE
IS NOT TRUTH. MUTATION REQUIRES A CANONICAL COMMAND OWNER — every UI action names the
canonical service that executes it; an action with no owner is omitted and documented,
never invented. STALE UI MUST FAIL LOUD, THEN REFRESH — a revision precondition refuses
the stale command with a typed conflict; the client re-reads the projection; newer durable
truth is never overwritten. EXTERNAL REFERENCE UI CONCEPTS MUST BE TRANSLATED TO COMPANYOS
CANONICAL OBJECTS — a reference product's control surface maps onto Goal Workspace +
RunObservationService + Decision/Approval; its Task/workflow/agent truths and AI-employee
org-chart authority are REJECTED, and cost/budget display is DEFERRED until canonical cost
truth exists (no fake estimates).

## Semantic Review
Before declaring complete the executor re-audits the frozen invariants (owners
unchanged, no second truths, no silent degradation, no exactly-once claims,
real provider real) and answers each contract audit question with evidence.
