# Sprint25 — Execution Interpretation (written BEFORE implementation, per §0)

## 0. Baseline and conflict statement

Baseline: `80e127d fix: separate provider session and invocation recovery`, working tree
clean (`git status --porcelain` = 0 lines), Sprint24 frozen at 202 test files / 2570
passing / 0 required skips, architecture guard PASS, `pnpm check` green.

**No conflict with the contract was found.** Every safety surface this sprint closes is
either (a) present but not yet enforced on the provider execution path, or (b) absent and
being introduced in the correct layer. No STOP condition fires. Specifics of what exists
today (probed, not assumed) are recorded in `S25_SECRETS_CONFIG_WORKSPACE_RECON.md`; the
load-bearing findings are repeated inline below because they constrain the design.

## 1. What Sprint25 is solving

Sprint24 made the canonical chain — Task → ExecutionAttempt → provider dispatch → real
external execution → durable evidence → settlement → observation — real against the local
DeepSeek Harness. It did so through one generic seam, and it proved the session/invocation
identity semantics. What it deliberately did NOT harden is the *environment the child
process inherits*, *the configuration the provider is built from*, and *the directory it is
spawned in*. Concretely, three verified defects/gaps exist today:

1. **Blind environment inheritance (defect).**
   `packages/engine/src/executor/process-executor-provider.ts:117` builds the child
   environment as `{ ...process.env, ...(config.env ?? {}) }`. The provider child therefore
   inherits every variable the CompanyOS process happens to hold — including credentials the
   operator's shell carried. The repository runtime already solved this exact problem
   (ADR-0028 D12, `buildFilteredProcessEnvironment` in
   `packages/engine/src/repository/repository-process-runner.ts`: an allowlist plus a
   secret-shape refusal on trusted additions). The executor seam must adopt the SAME law,
   not invent a second one.
2. **Unvalidated cwd (defect).** `apps/desktop/src/executor/provider-dispatch.ts` passes
   `deps.workspaceOf(runId, taskId)` straight into `request.workspace.cwd`, and
   `process-executor-provider.ts` passes it straight to `spawn(..., { cwd })`. Nothing
   checks it is absolute, exists, is a directory, or is the workspace the run is anchored
   to. The Sprint17 workspace authority (`createWorkspaceManager` +
   `createRepositoryPathPolicy`) already owns "which directory am I allowed to touch" — the
   executor path simply does not consult it.
3. **Ad-hoc, untyped configuration (gap).** Provider configuration is raw
   `process.env['DSH_NODE'] ?? ''` string reads in the desktop composition root. There is no
   typed config object, no named precedence, no provenance, and no way for a frozen
   ExecutionAttempt to state under which configuration it ran.

Additionally the Sprint24 contract itself flagged a prerequisite:
`SPRINT24_SECRETS_PREREQUISITE_BLOCKED` — "if a needed secret facility is missing". This
sprint resolves that prerequisite empirically (§17 below): the facility is NOT missing,
because the real provider does not need a secret from CompanyOS at all.

## 2. The eight statements (contract §0)

**S1 — SecretRef vs SecretValue are different kinds, and only one may travel.** A
`SecretRef` (pointer: `{ id, providerId, purpose, source, envName }`, already frozen in
`packages/core/src/ports/secrets.ts`) is a durable-shape-safe object: it names which
credential is needed and where it comes from, and it may be persisted, logged, projected and
carried in evidence. A resolved SecretValue is process-memory-only and lives exactly as long
as the resolution call that produced it. No resolved value is ever written to SQLite, an
event, an artifact, a handoff, a provider-dispatch row, an observation projection, a log
line, or an error detail. This is not a policy preference: it is the already-stated law of
the Sprint6 `SecretVault` ("values are held in memory only, for the lifetime of the
process") extended to the executor path, where today nothing enforces it.

**S2 — Secret failures fail CLOSED with typed, distinguishable codes.** Two new
`ErrorCode`s enter the frozen taxonomy: `SECRET_NOT_FOUND` (a ref names something that is
not configured) and `SECRET_SOURCE_UNAVAILABLE` (the source that should hold it — keychain,
external vault — cannot be reached). They are deliberately distinct because the operator's
remedy differs. Neither ever degrades into an empty string, a placeholder, a truncated
substitution, or a "best effort" continue; a missing secret is a failed dispatch with the
typed code, decided BEFORE any provider side effect. `requireSecret` today answers
`PERMISSION_DENIED`, which conflates "not configured" with "not permitted"; the typed pair
replaces that conflation.

**S3 — The local real provider needs NO CompanyOS-injected secret, proven by probe, not
assumed.** Probed against the installed runtime (`E:\DeepSeek.Harness`, dsh 0.1.6-max —
USER-SPECIFIED LOCAL RUNTIME CONSTRAINT; the installed version, not the newest official one,
is the capability authority):

```
env -i <node.exe> lib/bin.js --profile headless --json "Answer with exactly the word PONG..."
→ {"type":"session",...} ... {"type":"final","text":"PONG"}
env -i PATH=... SystemRoot=... WINDIR=... TEMP=... TMP=... <node.exe> lib/bin.js --profile headless --json "..."
→ {"type":"final","text":"PONG"}
```

A `grep` over the runtime's `lib/` and `config/` for `API_KEY|apiKey|api_key` returns no
files. So: the headless provider runs with a completely empty environment and with an
allowlist-only environment. **Therefore no secret read, no credential environment binding
and no vault reference is introduced for the local dsh executor in this sprint.** The
safety work is about NOT leaking, never about supplying. If a future provider genuinely
needs a value it goes through `SecretRef` + the vault + a declared, auditable injection
point — and if that mechanism did not exist, the STOP condition is to stop, not to improvise.

**S4 — Provider configuration is typed, validated, explicitly prioritised, and traceable to
its source.** Configuration stops being string reads at the composition root: a typed
descriptor is validated on load with an explicit precedence order, and every effective
value records which source produced it. Precedence (highest wins): trusted composition
option → named environment variable → declared default. A missing required field is a
VALIDATION_FAILED load, never a silent fallback. Configuration is the COMPOSITION's data,
like the existing `providerKinds`/`executorKinds` handler buckets — never a
provider-controlled and never a model-controlled input.

**S5 — A frozen ExecutionAttempt never re-reads live configuration.** Work executed under a
configuration is pinned to that configuration: the dispatch attempts to run under record a
fingerprint of the effective config they ran under, and resuming an attempt compares
against it instead of silently picking up whatever the environment says now. Config drift is
a typed, visible condition for the attempt (the frozen work's provenance stays true), never
a silent substitution that rewrites what a durable attempt did.

**S6 — The workspace root is an application authority, and cwd is validated on every spawn.**
The trusted root is resolved by the application (composition root) and is never taken from a
model, a provider, a provider's stdout, or a task payload. Before every spawn the cwd is
checked: present, non-empty, absolute, resolvable, and an existing directory — reusing the
Sprint17 workspace authority, which already demands an absolute root, realpath-resolves it
and directory-stats it. Windows path comparison is separator- and case-aware: containment
compares with a path component boundary (`C:\work\foo` must not accept `C:\work\foobar`),
never a raw string prefix. Sprint17's `createRepositoryPathPolicy` already implements
exactly this (platform-aware containment, "never a raw `startsWith(root)`"); the executor
path adopts it instead of re-deriving a weaker check.

**S7 — Escape attempts are refused, and the residual window is stated, not denied.** Parent
traversal (`..`), absolute paths, drive-qualified paths, UNC paths, `\\?\`/`\\.` device
paths, empty segments and reparse points (symlink/junction) are each rejected with their own
typed reason, as the Sprint17 path policy already does. A symlink or junction that resolves
inside a directory that is NOT the workspace root escapes the trust boundary and is refused.
**TOCTOU is documented as a real residual window**: verifying a path and then spawning in it
are two instants, and an attacker with local write access could swap a directory in between.
CompanyOS states this openly and does NOT claim to eliminate it; the mitigation is that the
trusted root is an application-supplied value in a directory ordinary task execution cannot
rewrite, plus re-validation at spawn time. Equally, nothing in this sprint is described as a
"sandbox": what exists is an authorization boundary ("which directory may I touch"), NOT an
isolation guarantee. Any doc, test name or error message that says "sandbox" as a security
claim is a violation of this sprint.

**S8 — Safety preflight is an ordered phase of the dispatch itself, before any provider side
effect, and it reuses the existing approval mechanism.** The order is fixed and each stage
fails closed: configuration valid → secret refs resolvable (V1: none required, S3) →
workspace trusted → cwd allowed → capabilities supported → authorization present. It occurs
strictly AFTER the canonical CompanyOS ExecutionAttempt claim is durably committed
(Transaction A: Task → RUNNING, ExecutionAttempt → ACTIVE, attempts += 1) and strictly
BEFORE any provider-side dispatch/publication or external side effect — inside the engine's
stage-handler window, outside any SQLite write transaction (V2 closeout: the ordering is
proven by `tests/sprint25/s25-claim-ordering.test.ts`). There is no
`SafetyAttempt` entity, no second lifecycle, no parallel truth: a preflight failure IS a
normal dispatch failure delivered as a typed result that the engine settles canonically
through existing transactions. Dangerous decisions (anything that would weaken the
boundary, e.g. running in an unverified directory, or a future provider requesting a
secret-carrying environment) reuse the existing Decision/Approval machinery
(`packages/core/src/domain/approval.ts`, `packages/engine/src/decision/decision-service.ts`,
codes `APPROVAL_REQUIRED`/`APPROVAL_DENIED`) — never an ad-hoc boolean flag. If a capability
has no existing approval mechanism, the capability is not built and the contract's STOP
condition fires.

## 3. Canonical owners that must NOT change

WorkflowVersion (pinned semantics) · Run (lifecycle) · Task (work lifecycle) ·
ExecutionAttempt (attempt identity/ownership/recovery/settlement — the safety phase lives
INSIDE it, never beside it) · AgentExecution (provenance only) · provider_dispatches
(subordinate binding) · Artifact/Evidence/Validation/Finding · HandoffService ·
RunObservationService (read-only) · the Decision/Approval services. Safety is a PRECONDITION
of execution, not a new owner of execution truth.

## 4. Production modules I expect to change

- `packages/core/src/kernel/errors.ts` — two new codes (`SECRET_NOT_FOUND`,
  `SECRET_SOURCE_UNAVAILABLE`). Additive only; no existing code changes meaning.
- `packages/engine/src/executor/executor-provider.ts` — the `ExecutorEnvironment` request/
  config surface: an explicit, declared environment policy object (allowlist + declared
  additions + per-key secret-shape refusal), typed environment/config failure codes, and the
  typed preflight result type. Still vendor-neutral.
- `packages/engine/src/executor/process-executor-provider.ts` — stop inheriting
  `process.env`; build the child env through the allowlist policy; validate cwd (present,
  absolute, existing directory) before spawn; keep `shell:false`, windowsHide, bounded
  capture, output-limit tree termination, composition-armed timer (Sprint24 laws unchanged).
- `packages/engine/src/executor/execution-safety.ts` (NEW) — the ordered preflight
  (config → secrets → workspace → cwd → capabilities → authorization) returning a typed
  verdict, and the provider-config schema/validator with source provenance + fingerprint.
  Engine layer, vendor-free.
- `packages/engine/src/repository/workspace.ts` / `path-policy.ts` — extended minimally to
  expose "is this path a trusted cwd for this workspace" to the executor seam (reuse, not a
  fork).
- `apps/desktop/src/executor/` — the dsh adapter takes a TYPED config object (validated at
  composition) instead of raw `?? ''` reads; composition wires the new config loader.
- `apps/desktop/src/core-services.ts` — provider config resolution through the typed loader
  with named precedence; the safety preflight inserted into `provider-dispatch.ts` before
  `provider.start`.

## 5. What I explicitly will NOT build

No secret storage facility (no keychain writer, no vault of my own — the Sprint6 vault
exists and is reused only by reference). No credential injection for the local dsh provider
(S3). No second workspace manager, second path policy, second environment policy, second
approval mechanism, second scheduler/queue/truth. No `SafetyAttempt` lifecycle. No OS-level
isolation, no container, no restricted token, no job object — and NO claim that any of those
exist. No weakening of Sprint24's `shell:false`, bounded output, tree termination, or
capability negotiation. No test that only checks a code path that cannot fail.

## 6. External-reference mechanisms being adapted (SELECTIVE ADAPTATION)

Explicit child-environment allowlisting with a secret-shape refusal on additions (adapted
from the repo's own ADR-0028 D12 policy, which itself mirrors the "don't leak the parent
environment" discipline common to process-launching subsystems) · typed configuration with
named precedence and provenance (adapted from providers' "validated settings + effective
value reporting" discipline) · a pre-spawn workspace/cwd trust check (adapted from the
Sprint17 authority already in this repository, never a new one). **Rejected:** any OS-level
sandbox primitive, any in-process secret encryption theatre, any ambient-credential
discovery, any "trust but verify later" deferral.

## 7. STOP conditions

`S25_APPROVAL_MECHANISM_MISSING` — a dangerous capability is required but no existing
Decision/Approval seam can express it (do NOT invent an ad-hoc boolean; stop instead) ·
`S25_SECRET_SOURCE_WEAKENING` — implementing safety would require weakening an existing
boundary (e.g. re-enabling env inheritance to make a provider work) ·
`S25_PROVIDER_FLAG_LEAK` — a provider-specific CLI flag would have to enter Core ·
`S25_BASELINE_UNVERIFIED` — the baseline commit/tree does not match ·
`S25_SANDBOX_CLAIM` — the only way to satisfy a requirement would be to claim isolation that
is not implemented · AMBIGUITY → STOP, never guess (per EXECUTOR_PROTOCOL).

## 8. Definition of success

Every provider spawn now happens with an explicit allowlisted environment (never the parent
environment), a validated typed configuration carrying its source and effective value, and a
cwd proven trusted by the workspace authority immediately before the spawn; secret
resolution failures are typed and fail closed before any external side effect; the ordered
preflight runs inside the canonical attempt with no second lifecycle; the safety boundaries
are proven by the contract's 12 secret / 8 config / 13 workspace / preflight-ordering /
failure-injection suites plus a real dsh smoke (3 consecutive real invocations, sanitized
environment, real settlement), the architecture guard PASSES with no weakening law, the
frozen Sprint18–24 baselines are unreduced, and every document tells the truth about what is
and is not guaranteed — including the TOCTOU window and the absence of a sandbox.

## §47 interpretation check (each statement confirmed)

No second truth ✓ (preflight is an ordered phase inside the canonical attempt) · no second
approval mechanism ✓ (Decision/Approval reused) · no secret stored ✓ (SecretRef only; local
provider needs none — probed with an empty environment) · no env inheritance ✓ (allowlist,
the ADR-0028 pattern) · no silent config drift ✓ (fingerprint + explicit precedence) · no
string-prefix path trust ✓ (component-boundary comparison) · no sandbox claim ✓ (stated as
an authorization boundary with a documented TOCTOU window) · real provider stays real ✓
(dsh runs with a sanitized environment and still answers "PONG").
