# Sprint24 — Execution Interpretation (written BEFORE implementation, per §0)

## 1. What Sprint24 is solving

CompanyOS's canonical execution runtime currently reaches only deterministic fake
executors through real seams (the S21/S22 gap `REAL_PRODUCTION_PROVIDER_EXECUTOR`).
Sprint24 connects the canonical chain — Task → canonical ExecutionAttempt →
provider dispatch → REAL external execution → durable result/evidence →
settlement → observation — through ONE generic CompanyOS-native
Provider/Executor seam (`ExecutorProvider` + capability negotiation + a
deterministic dispatch binding subordinate to ExecutionAttempt), and proves it
against a real locally-installed external executor.

**Verified local fact (probed before this document; USER-SPECIFIED LOCAL RUNTIME CONSTRAINT — the installed runtime, not the newest official version, is the capability authority):** DeepSeek Harness IS
installed at `E:\DeepSeek.Harness` and ships a stable non-GUI CLI:
`dsh --profile headless [--json] [--session-id <id>] "<task>"` — answers one
task and exits; `--json` emits NDJSON run events (`session`/`status`/`text`/
`final`); exit code 0 on success. A live probe returned `{"type":"final","text":"PONG"}`
with real token usage. This is the primary real provider candidate.

## 2. Canonical owners that must NOT change

WorkflowVersion (pinned semantics) · Run (lifecycle) · Task (work lifecycle) ·
ExecutionAttempt (attempt identity/ownership/recovery/settlement) ·
AgentExecution (model provenance ONLY) · Artifact/Evidence/Validation/Finding
(their truths) · HandoffService (sole handoff owner) · RunObservationService
(read-only). The provider seam is IMPLEMENTATION authority only.

## 3. Production modules I expect to change

- `packages/engine/src/executor/` (NEW): the `ExecutorProvider` contract —
  capability descriptor, typed request/result/failure taxonomy, deterministic
  dispatch-key derivation, `ExecutorProviderRegistry` (implementation discovery
  only), and a vendor-neutral generic `ProcessExecutorProvider` (spawn/exit/
  bounded output/timeout/kill — engine already hosts process mechanics in the
  ADR-0028 repository seam, so this is an established pattern).
- `packages/persistence/`: `engine/0004_provider_dispatches.sql` + a guarded
  store for the durable provider binding (dispatch_key UNIQUE = deterministic
  idempotency; external_run_id; state) — subordinate to ExecutionAttempt, with
  the ARCH-006 table-inventory amendment recorded in the law doc.
- `apps/desktop/src/`: the dsh adapter (providerKey `dsh-headless`; NDJSON
  parsing; session-id = external run identity; `--session-id` continuation) —
  it lives OUTSIDE the engine because the engine's frozen boundary bans vendor
  names; plus composition wiring (a `providerKinds` handler bucket — trusted
  registration data, exactly like `executorKinds`).
- `packages/engine/src/observability/`: expose provider facts (providerKey,
  external identity known?, settled?, uncertain?, recovery available) — read-only.
- `packages/engine/src/engine.ts`: NO claim/settlement changes — the provider
  dispatch happens inside the existing StageHandler window (after claim tx A,
  before settlement tx B), which already satisfies claim-before-executor and
  no-write-tx-across-executor (ARCH-021/022).

## 4. What I explicitly will NOT build

No second Task/ExecutionAttempt/scheduler/DAG/queue/truth (ARCH-005/006 law).
No ProviderAttempt lifecycle that decides attempt numbers, Task success, retry
counts or Run state. No AgentExecution fabrication for non-model shells. No
secret storage. No universal shell templating language — provider-specific
protocol stays in its adapter. No GUI automation. No Cordis. No Software-
specific fields in generic interfaces (gitBranch/pullRequest etc. only via
pack WorkPackages). No universal exactly-once claim. No Product Control Plane.

## 5. External-reference mechanisms being adapted (DeepSeek Harness, SELECTIVE ADAPTATION)

Capability seam (Service Definition→Provider→Consumer ⇒ ExecutorProvider
contract→implementation→engine consumer) · named providers behind one registry
(implementation discovery only) · fail-loud capability advertisement (typed
capability descriptor; required ⊆ provider, else typed pre-invocation
mismatch) · published-run boundary (pre-publication rejection creates NO fake
external run; externalRunId only from real provider evidence) · durable
identity vs live activation (ExecutionAttempt durable; process handle live,
never durable) · single cancellation channel (AbortSignal; request ≠ proof of
stop) · no second queue · accepted-run ownership (registry changes never
rewrite attempt history). **Rejected:** Cordis as Core, Session as truth,
Agent Teams Task DAG, second queue/scheduler/state machine.

## 6. STOP conditions

`SPRINT24_BASELINE_ARCHITECTURE_DEFECT` if a frozen ownership boundary proves
defective · `SPRINT24_REAL_PROVIDER_RUNTIME_UNAVAILABLE` if no real automation
interface exists (NOT the case — dsh verified) ·
`SPRINT24_SECRETS_PREREQUISITE_BLOCKED` if a needed secret facility is missing ·
AMBIGUITY → STOP, never guess (per EXECUTOR_PROTOCOL).

## 7. Definition of success

One REAL external execution through the production seam: a real Task claimed
by the engine (canonical attempt), dispatched to the real dsh headless
provider, real external execution (verified NDJSON final + exit code), durable
dispatch binding + result evidence, canonical settlement through the existing
engine transactions, and full observation — with the 30 contract tests, crash
windows A–D, failure injection, recovery probe, architecture guard green, and
the frozen Sprint18-23 baselines unreduced.

## §47 interpretation check (each statement confirmed)

Task remains truth owner ✓ · ExecutionAttempt remains attempt owner ✓ ·
Provider is implementation ✓ · AgentExecution is provenance ✓ · capability
mismatch fails loud ✓ · no second scheduler ✓ · no second queue ✓ · no
exactly-once claim ✓ · real external provider required ✓ (dsh verified).
No material ambiguity remains against the contract.
