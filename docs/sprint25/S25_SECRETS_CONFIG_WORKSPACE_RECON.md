# Sprint25 — Secrets / Config / Workspace Recon (contract §4)

Probed against baseline `80e127d` with a clean tree. Everything below was read from the
repository or executed against the installed runtime — nothing is inferred. Where a surface
does not exist, it is listed as a gap, not assumed away.

## 1. What already exists (and must be reused, not forked)

| Surface | Owner / file | State | Sprint25 treatment |
|---|---|---|---|
| `SecretRef` (pointer: `id`, `providerId`, `purpose`, `source`, `envName`) | `packages/core/src/ports/secrets.ts` | frozen since Sprint 6; already documented as "the only shape that may be persisted or logged" | **Reused verbatim.** It is the durable-safe form. No change. |
| `SecretResolver` / `SecretRefResolverPort` | `packages/core/src/ports/secrets.ts` | `get/set/delete/keys` + `resolve/available` | **Reused.** `available()` lists names, never values. |
| `SecretVault` (env/keychain resolver, in-memory values, redaction registry, authority-checked `read/write/remove`, `forActor` view) | `packages/engine/src/providers/secret-vault.ts` | Sprint 6 built, Sprint 7 authority-checked | **Reused as the only value-holding surface.** Sprint25 adds no storage. |
| `redactSecrets` / `redactValue` / `assertNoSecrets` | `packages/core/src/domain/provider-error.ts` | used by the tool registry (`tools/registry.ts:155`) and the agent runtime | **Reused as the single redaction authority** for the executor path. |
| `buildFilteredProcessEnvironment` (allowlist + `SECRET_ENV_PATTERN` refusal + `ENV_KEY_PATTERN` + NUL refusal) | `packages/engine/src/repository/repository-process-runner.ts:84` | production, ADR-0028 D12/D18/D19, frozen | **Reused.** The executor provider must build its child environment through this same policy — never a second environment policy. |
| `createWorkspaceManager` (absolute-root demand, realpath canonicalization, `isDirectory` stat, single active workspace, profile-match guard, lease-guarded close) | `packages/engine/src/repository/workspace.ts` | production, Sprint 17 / ADR-0028 D2/D3/D27 | **Reused as the workspace authority for the executor cwd.** |
| `createRepositoryPathPolicy` (component-boundary containment — "never a raw `startsWith(root)`", `..`/absolute/drive-qualified/UNC/`\\?\`-device/empty-segment refusal, reparse-point refusal) | `packages/engine/src/repository/path-policy.ts` | production, ADR-0028 D11–D13 | **Reused for escape decisions** on the executor cwd. |
| `Approval` domain + `requestApproval` / `decideApproval` / `expireApproval` / `APPROVAL_AUTHORITY` | `packages/core/src/domain/approval.ts` | frozen domain | **Reused** — the only approval mechanism (§29). |
| `DecisionService` (versioned, authority-checked, audit-emitting decisions) | `packages/engine/src/decision/decision-service.ts` | production | **Reused** for durable authorization provenance. |
| `ExecutorProvider` contract + capability negotiation + deterministic dispatch binding | `packages/engine/src/executor/` | Sprint 24 | Extended (typed env/config + preflight), never replaced. |

## 2. Verified defects and gaps on the provider execution path

### 2.1 D1 — blind parent-environment inheritance (SECURITY DEFECT, must fix)

`packages/engine/src/executor/process-executor-provider.ts:117`

```ts
env: { ...process.env, ...(config.env ?? {}) },
```

Every variable the CompanyOS process holds is handed to the provider child, including
credentials the operator's shell carried. The repository runtime already solves this exact
problem with an allowlist (`buildFilteredProcessEnvironment`, ADR-0028 D12) and documents
why: "a repository process cannot inherit a credential the shell happened to carry". The
executor seam currently has no such discipline. Comment in the same file ("no secret ever
enters argv or the environment we pass") is therefore not yet true of the environment it
builds.

### 2.2 D2 — cwd is trusted without any validation (SECURITY DEFECT, must fix)

- `apps/desktop/src/executor/provider-dispatch.ts:156-158` reads
  `deps.workspaceOf(runId, taskId)` twice and passes the raw string as
  `request.workspace.cwd`.
- `packages/engine/src/executor/process-executor-provider.ts:114-120` passes it straight to
  `spawn(..., { cwd })` with no absolute/absolute-exists/directory/containment check. The
  only guard is `request.workspace?.cwd ?? config.fallbackCwd === null` — i.e. "is it
  non-null", not "is it trusted".
- Nothing on this path consults `createWorkspaceManager` at all, so "which run is anchored to
  which canonical root" is not enforced for provider executions.
- `workspaceOf` returns `null` today for provider-backed kinds, so the provider actually runs
  in `config.fallbackCwd` — which for dsh is `config.runtimeDir` (see D4). Any future wiring
  that returns a real path inherits the unvalidated hole.

### 2.3 D3 — configuration is raw string reads with silent fallbacks (GAP)

`apps/desktop/src/core-services.ts:2439-2440`

```ts
const dshNode = process.env['DSH_NODE'] ?? '';
const dshRuntime = process.env['DSH_RUNTIME'] ?? '';
```

No typing, no validation (a non-absolute path is accepted), no precedence rule, no record of
which source produced a value, and `COMPANYOS_RENDERER_URL` (main.ts) is the same shape. A
misconfiguration therefore surfaces as an ENOENT from `spawn` deep inside a provider call
rather than as a validated load failure.

### 2.4 D4 — the dsh adapter ignores its own declared `fallbackCwd` (DEFECT, must fix)

`apps/desktop/src/executor/dsh-executor-provider.ts:41-47` declares
`fallbackCwd: string | null` in `DshProviderConfig`, but line 71 hardcodes
`fallbackCwd: config.runtimeDir`. The declared configuration value is silently ignored — the
exact "silent weakening" this sprint forbids.

### 2.5 D5 — secret failure is a conflated error code (GAP)

`requireSecret` (`packages/engine/src/providers/secret-vault.ts:172-188`) answers
`PERMISSION_DENIED` for "not configured". Not-configured (operator action: set a value) and
not-permitted (policy action: grant authority) have different remedies and must be
distinguishable. Typed `SECRET_NOT_FOUND` / `SECRET_SOURCE_UNAVAILABLE` codes do not exist in
`ERROR_CODES` today.

### 2.6 D6 — no safety preflight exists between attempt claim and provider side effects

The canonical order today is: capability assert (dispatch orchestration) → dispatch claim →
SAFE-REPLAY check → `provider.start`. There is no ordered phase that validates configuration,
secret refs, workspace trust, cwd legality and authorization before the external call, and no
typed verdict describing safety decisions for observation.

## 3. Verified local-runtime facts (USER-SPECIFIED LOCAL RUNTIME CONSTRAINT)

Installed runtime: `E:\DeepSeek.Harness\DeepSeek Harness`, dsh 0.1.6-max (the installed
version — NOT the newest official one — is the capability authority; no upstream fetch, no
upgrade). Execution commands were run for this recon:

```
# F1 — completely sanitized environment (env -i: nothing inherited at all)
env -i <node.exe> lib/bin.js --profile headless --json "Answer with exactly the word PONG and nothing else."
→ {"type":"session","sessionId":"session-e7b99466-…","cwd":"E:\\…\\runtime"}
→ {"type":"status","phase":"turn_start","turn":1} … {"type":"text","text":"PONG"}
→ {"type":"final","text":"PONG"}          (real token usage present)

# F2 — allowlist-only environment, the shape the repo runner already builds
env -i PATH=… SystemRoot=… WINDIR=… TEMP=… TMP=… <node.exe> lib/bin.js --profile headless --json "…"
→ {"type":"text","text":"PONG"} … {"type":"final","text":"PONG"}

# F3 — credential surface search over the runtime
grep -rl "API_KEY|apiKey|api_key" lib/ config/     → no files
```

**Conclusion (§17, fact not assumption):** the locally installed headless provider reads NO
credential from the parent environment. It answers correctly with an empty environment and
with an allowlist-only environment. Therefore:

1. No CompanyOS-injected secret is required for the local dsh executor, and none is built.
2. An env allowlist is SAFE for the real provider — the sanitized smoke is a contract test,
   not a theoretical claim.
3. No API-key requirement is fabricated, and the local runtime is not upgraded to obtain one.

## 4. Source-of-truth matrix (contract §5)

| Fact | Single owner | Consumers (read-only) | Never a source of truth |
|---|---|---|---|
| Which credentials exist / their values | `SecretVault` (process memory) | composition root, adapters (via `forActor` view) | SQLite, events, artifacts, dispatch rows, logs |
| Which credential a provider needs | `SecretRef` | provider config, dispatch request, observation | raw values anywhere |
| Child-process environment | `buildFilteredProcessEnvironment` policy (allowlist + secret-shape refusal) | the executor process provider | `process.env` spread |
| Secret failure meaning | core `ErrorCode`s `SECRET_NOT_FOUND` / `SECRET_SOURCE_UNAVAILABLE` (added this sprint) | dispatch result, preflight verdict, observation blocker | ad-hoc strings, `PERMISSION_DENIED` conflation |
| Redaction of any text before logging/emitting | `redactSecrets` / `redactValue` (Core) | tool registry, agent runtime, executor diagnostics | per-call-site ad-hoc masking |
| Trusted workspace root + identity | `createWorkspaceManager` (`canonicalRoot`, `workspaceId`) | repository tools, executor preflight (this sprint) | model text, provider stdout, task payload |
| Path escape decisions | `createRepositoryPathPolicy` (component boundary, reparse refusal) | repository tools, executor cwd check (this sprint) | raw string prefix comparison |
| Effective provider configuration | typed, validated config object with per-value source provenance | composition, dispatch request fingerprint | live re-reads of `process.env` at call time |
| What a frozen attempt ran under | the ExecutionAttempt's config fingerprint | resume/recovery comparison | the current environment |
| Dangerous-action authorization | `Approval` / `DecisionService` | any capability that weakens the boundary | ad-hoc booleans |
| Safety decision record | the preflight verdict inside the canonical dispatch | RunObservationService (read-only projection) | a second lifecycle entity |

## 5. What Sprint25 must therefore build (derived, not invented)

1. Typed environment policy for the executor child (`allowlist` + `declaredAdditions` with
   the existing name/value/secret-shape validation) — one policy, shared with the repo path.
2. Typed, validated provider configuration with named precedence + per-value provenance +
   a deterministic fingerprint, loaded at composition time.
3. A workspace/cwd authority on the executor path (reusing `WorkspaceManager` + path policy:
   absolute, existing directory, canonical, contained, no reparse escape).
4. The ordered safety preflight (config → secrets → workspace → cwd → capabilities →
   authorization) as a typed verdict inside the canonical attempt, before any provider side
   effect.
5. `SECRET_NOT_FOUND` / `SECRET_SOURCE_UNAVAILABLE` typed codes, and centralized redaction on
   the executor path.
6. The dsh adapter's `fallbackCwd` honored + typed config input (fix D4/D3).
7. Tests + guard laws + documentation, all stating the TOCTOU window and the absence of any
   sandbox claim.

## 6. STOP-condition check (none fire)

An approval mechanism exists (`S25_APPROVAL_MECHANISM_MISSING` does not fire) · safety can be
implemented without weakening any existing boundary — the only thing that changes behavior is
that the parent environment stops being inherited, which F1/F2 prove is safe for the real
provider (`S25_SECRET_SOURCE_WEAKENING` does not fire) · no provider-specific flag needs to
enter Core (`S25_PROVIDER_FLAG_LEAK` does not fire) · no requirement needs an unimplemented
isolation primitive (`S25_SANDBOX_CLAIM` does not fire) · baseline verified
(`S25_BASELINE_UNVERIFIED` does not fire).
