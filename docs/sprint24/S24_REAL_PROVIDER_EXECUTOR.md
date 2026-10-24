# S24 — Real Production Provider / Executor (FROZEN)

Baseline `e4cc6e7`. Mission: connect CompanyOS canonical execution to a REAL
external provider through a generic CompanyOS-native seam — proven end to end:
Task → canonical ExecutionAttempt → provider dispatch → real external execution
→ durable result → canonical settlement → observation. Companion docs:
`S24_EXECUTION_INTERPRETATION.md`, `S24_PROVIDER_EXECUTOR_RECON.md`,
`S24_REAL_PROVIDER_SELECTION.md`, `docs/implementation/EXECUTOR_PROTOCOL.md`.

## Architecture

- **Contract** (`packages/engine/src/executor/executor-provider.ts`): the
  vendor-neutral `ExecutorProvider` seam (DeepSeek reference: capability seam
  Service Definition → Provider → Consumer ⇒ contract → implementation → engine
  consumer). Closed 11-name capability vocabulary; typed request carrying ONLY
  trusted CompanyOS inputs (canonical identities are INPUTS — a provider never
  chooses Task/Run/Attempt/WorkflowVersion ids); 6-kind outcome taxonomy
  (succeeded / provider-failed / transport-failed / cancelled / timeout /
  **uncertain**); `assertExecutorCapabilities` (required ⊆ provider, else a
  typed NON-RETRYABLE mismatch BEFORE invocation — no silent degradation);
  deterministic `providerDispatchKeyOf` / `providerDispatchIdOf`
  (`dsp_`/`pdi_` + sha256[0:26] of company:run:task:attemptNumber:providerKey).
- **Registry** (`createExecutorProviderRegistry`): implementation authority
  ONLY — describeAll/resolve; no workflow surface.
- **Generic process provider**
  (`packages/engine/src/executor/process-executor-provider.ts`): the shared
  process mechanics (§36) — spawn(shell:false, windowsHide), bounded 1MiB
  capture per stream with OUTPUT_LIMIT tree termination, exit code/instants,
  taskkill /T /F tree kill (the repository seam's proven primitive),
  AbortSignal as the single cancellation channel (request ≠ proof; proof only
  via exit evidence), `parseNdjsonEvents` (malformed ⇒ typed
  EXECUTOR_NDJSON_MALFORMED, never coerced success).
- **dsh adapter** (`apps/desktop/src/executor/dsh-executor-provider.ts`, in the
  composition because the engine boundary is vendor-name-free):
  providerKey `dsh-headless`; argv `node lib/bin.js --profile headless --json
  [--session-id <id>] <task>`; NDJSON events parsed for the REAL session id
  (external identity, never manufactured) and the `final` answer.
- **Durable binding** (`engine/0004_provider_dispatches.sql` +
  `sqlite-provider-dispatch-store.ts`): `provider_dispatches` — SUBORDINATE to
  ExecutionAttempt (records providerKey/dispatchKey/externalRunId/state
  DISPATCHED→PUBLISHED→SETTLED/UNCERTAIN); UNIQUE(dispatch_key) = deterministic
  guarded claim (same attempt+provider ⇒ same row replayed forever; different
  attempts never share). ARCH-006 inventory amendment recorded in the law doc.
- **Dispatch orchestration**
  (`apps/desktop/src/executor/provider-dispatch.ts` + a `providerKinds`
  handler bucket): runs INSIDE the engine StageHandler window — strictly after
  the canonical claim transaction and outside any write transaction
  (ARCH-021/022 unchanged); negotiates capabilities, claims the dispatch row,
  invokes the provider, publishes the real external identity, resumes a
  PUBLISHED session on recovery (§26), and returns the envelope the ENGINE
  settles canonically — provider success alone never settles a Task.
- **Observation**: `TaskObservation.provider` facts (providerKey, dispatchKey,
  externalRunId, state, recoveryAvailable) read from the binding (read-only).

## Capability negotiation

Required ⊆ advertised, checked before dispatch. The dsh provider truthfully
advertises: timeout, structured-output, working-directory, stdin,
external-run-identity, recovery-resume, streaming-diagnostics, cancellation
(kill-tree REQUEST). NOT advertised (loudly): status-query, idempotency-key,
environment-inputs.

## Selected real provider: DeepSeek Harness headless (dsh)

Per `S24_REAL_PROVIDER_SELECTION.md` — the locally installed stable automation
surface (recon verified live). Boss ruling recorded: the LOCAL install is the
reference; no GitHub newer version is fetched.

## DeepSeek Harness mapping (adapted vs rejected)

Adapted: capability seam; named providers behind one registry (implementation
discovery only); fail-loud capabilities; published-run boundary
(pre-publication rejection creates NO fake external run; externalRunId only
from real evidence); durable identity vs live activation (ExecutionAttempt
durable; process handle live); single cancellation channel (AbortSignal);
no second queue; accepted-run ownership (registry changes never rewrite
attempt history). Rejected: Cordis as Core; Session as workflow truth; Agent
Teams Task DAG; second queue/scheduler/state machine.

## Identity matrix (frozen — local installed runtime is the authority)

USER-SPECIFIED LOCAL RUNTIME CONSTRAINT: the currently installed DeepSeek Harness
(`E:\DeepSeek.Harness`, dsh 0.1.6-max — NOT the newest official version) is the actual
production validation target; capability and recovery semantics are determined ONLY from
this local runtime's verified behavior (§32: no upstream substitution).

| Identity | Created by | Durable | Across restart | Unique per invocation | Shareable | Continuation | Query/recovery | Proves settlement | Idempotency-safe |
|---|---|---|---|---|---|---|---|---|---|
| CompanyOS ExecutionAttempt id | engine claim tx | YES | YES (same id/number) | YES (per attempt) | no | n/a | Sprint21 same-attempt recovery | with settlement tx | n/a |
| CompanyOS dispatchKey (`dsp_`) | CompanyOS derivation | YES (binding row) | YES | YES (attempt+provider) | no | n/a | binding replay identity | no | CompanyOS-side only |
| Provider Session id (`session-…`) | PROVIDER (dsh) | YES (`~/.dsh/sessions/…/session.v3.jsonl.zstd`) | YES (adopted by new CLI processes) | **NO** — one conversation, MANY turns | yes (many turns/invocations) | YES (`--session-id` = resume CONVERSATION) | query NO / reattach NO | NO | NO |
| Provider invocation id | — | — | — | — | — | — | UNSUPPORTED (no such id exists locally) | — | — |
| Provider process PID | OS | no | no (dead) | per process | no | no | no | NO | no |
| Provider result / evidence | provider NDJSON | captured in outcome/binding summary | via binding | per invocation | no | n/a | n/a | only WITH canonical settlement tx | n/a |

**`--session-id` semantics (local evidence):** OBSERVED FACT — a second CLI process with
`--session-id session-c4fc3746…` emitted `{"phase":"turn_start","turn":2}` and answered
from turn 1's memory ("MARBLE"); an unknown id is an ERROR ("session … does not exist;
omit --session-id to start a new Session"). INTERPRETATION — `--session-id` identifies and
resumes the durable CONVERSATION (session continuation), NOT one exact invocation. A
session may contain many turns; therefore sessionId never identifies one external
execution and is never exposed as externalRunId/externalInvocationId. The binding column
is `provider_session_id`; `provider_invocation_id` stays null without provider evidence
(UNSUPORTED). Can the local CLI query an in-flight invocation without a new task? NO
(the surface is only `--json`/`--session-id`/task). Can it reattach to an exact in-flight
invocation? NO.

## PUBLISHED, continuation vs recovery, safe replay

PUBLISHED = **the provider EVIDENCED a durable session identity** (conversation truth —
real provider-issued id only, never manufactured). It is NOT a claim that one exact
external invocation exists or settled.

- **CONTINUATION** = submitting later NEW work into the same durable provider session
  (explicit caller decision via `continuationSessionId`; §21). **SAME-INVOCATION
  RECOVERY** = reattaching/querying/resuming the exact previously-started invocation
  without starting another one. NOT equivalent: dsh supports the former only
  (`SESSION_CONTINUATION=SUPPORTED`, `SAME_INVOCATION_RECOVERY=UNSUPPORTED`).
- **Safe-replay rule (§20/§16):** UNCERTAIN external side effect + no provider
  idempotency/query proof → DO NOT AUTOMATICALLY REPLAY. Same sessionId does NOT make
  replay safe. The dispatch orchestration enforces this structurally: a binding in
  PUBLISHED or UNCERTAIN (a previous invocation may have run without proven settlement)
  refuses re-invocation and marks UNCERTAIN — never an auto-replay labelled "recovery".

## Crash matrix (corrected)

| Window | State after restart | Behavior |
|---|---|---|
| A (claim durable, provider NOT called) | same attemptId/number, Task.attempts unchanged | provider MAY be invoked for the same attempt (DISPATCHED binding permits it) |
| B (may have invoked; nothing trustworthy) | outcome UNKNOWN | honest UNCERTAIN; no automatic replay; replay never called "recovery" |
| C1 (durable session, unknown invocation) | session known, previous invocation outcome unknown | NO auto-replay of the original task (fail closed, UNCERTAIN); session continuation remains available for DELIBERATE new work |
| C2 (exact invocation recovery) | — | UNSUPPORTED (no invocation identity, no query) — acceptable, not a Sprint24 failure |
| D (final observed, settlement not committed) | binding PUBLISHED/UNCERTAIN, Task unsettled | provider result alone NEVER sets Task DONE; canonical settlement still required; outcome recorded as observed-but-unsettled or UNCERTAIN |

## Publication boundary, external identity, idempotency

Pre-publication provider rejection ⇒ no externalRunId manufactured. The REAL
session id is bound only from emitted NDJSON evidence (`publish`). CompanyOS's
deterministic dispatch key is OUR binding identity — the provider supports no
idempotency key, and CompanyOS claims nothing it does not support. Query:
UNSUPPORTED. Resume/continuation: SUPPORTED (`--session-id`).

## Provider-capability recovery matrix (§28, per installed runtime)

(Interpretation above governs: session-continuation is the only recovery-shaped capability the installed dsh actually provides.)

## Legacy matrix (§28)

| Capability | Crash point | Safe action | Duplicate possible? | Canonical state | Human? |
|---|---|---|---|---|---|
| no idempotency/no query (window B) | after invocation, nothing durable | mark UNCERTAIN; explicit policy | YES | Task unsettled; attempt recovery same attempt | report |
| dispatch key only (window A) | claim committed, provider not called | invoke provider for the SAME attempt | no (never invoked) | Task RUNNING/attempt recovery | no |
| externalRunId + resume (window C) | published, settlement absent | resume the SAME session | continuation, not duplicate | same attempt, session continued | no |
| cancel support | cancel racing exit | record cancellation; proof only via exit evidence | possible | UNCERTAIN unless proven | no |
| resume/continuation | crash mid-continuation | resume again with same session id | possible duplicate continuation | per outcome kind | no |
| window D | final returned, settlement tx not committed | binding PUBLISHED/UNCERTAIN; engine replays settlement | possible re-delivery | Task unsettled until engine tx | no |

## Cancellation, timeout, structured output

Cancellation: AbortSignal → kill tree; request ≠ proof. Timeout: bounded
(120s smoke); termination proven only by exit evidence. Structured output:
NDJSON validated by the trusted parser; malformed ⇒ provider-failed
(EXECUTOR_NDJSON_MALFORMED), never success.

## Failure taxonomy

succeeded / provider-failed (business) / transport-failed (launch/infra) /
cancelled / timeout / uncertain — each with bounded diagnostics; secrets never
enter argv, env or diagnostics.

## Workspace & secrets boundary

Trusted cwd or EXECUTOR_WORKSPACE_UNTRUSTED fail-closed BEFORE any spawn. No
new secret storage; the provider receives only the task text. (The SECRETS
sprint remains OPEN.)

## Observability mapping

TaskObservation.provider exposes providerKey/dispatchKey/externalRunId/state/
recoveryAvailable; uncertainty blocks unchanged from S23.

## Known limitations & exactly-once disclaimer

No status query; continuation may duplicate work across crashes; provider-side
idempotency absent. **Universal external exactly-once is NOT claimed**
(Sprint21 §26 unchanged).

## Tests

`tests/sprint24/s24-provider-contract.test.ts` (20 — capability negotiation,
dispatch determinism, registry authority, binding claim/replay/conflict,
cross-scope isolation, outcome taxonomy, REAL process mechanics incl. timeout/
non-zero/fail-closed workspace/NDJSON), `s24-crash-recovery.test.ts` (9 —
windows A/B/C/D + failure injection incl. loud capability mismatch),
`s24-real-provider-smoke.test.ts` (6 — 3 REAL dsh invocations + §50 recovery
probe resuming the same session + truthful capability set). Real smoke runs
live; it fails (never skips) when the runtime is absent.
