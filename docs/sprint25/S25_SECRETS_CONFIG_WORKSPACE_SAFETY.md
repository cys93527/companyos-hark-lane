# Sprint25 — Secrets / Config / Workspace Safety (FROZEN)

Baseline `80e127d` (Sprint24 frozen) · interpretation-first per contract §0
(`S25_EXECUTION_INTERPRETATION.md` written BEFORE any production change) · recon in
`S25_SECRETS_CONFIG_WORKSPACE_RECON.md`.

Sprint24 made the canonical execution chain real against the installed DeepSeek Harness. It
did so without hardening three things: the environment a provider child inherits, the
configuration a provider is built from, and the directory it is spawned in. This sprint
closes those three gaps by REUSING what the repository already owns and adding exactly one
new seam: the ordered safety preflight inside the canonical attempt.

## 1. What was wrong (probed, not assumed)

| # | Defect | Where | Fix |
|---|---|---|---|
| D1 | The provider child inherited the whole parent environment (`{ ...process.env, ...(env ?? {}) }`), so any credential the operator's shell carried crossed the boundary | `process-executor-provider.ts` | one environment law: allowlist + validated additions |
| D2 | The dispatch passed a resolver's string straight to `spawn(cwd)` with no absolute/existing/containment/reparse check | `provider-dispatch.ts` + `process-executor-provider.ts` | workspace authority per spawn (root + canonical cwd travelling together) |
| D3 | Provider configuration was `process.env['DSH_NODE'] ?? ''` — untyped, unvalidated, no precedence, no provenance | `core-services.ts` | typed schema + named precedence + per-value source |
| D4 | The dsh adapter declared `fallbackCwd` and then hardcoded the runtime dir instead (a silent override of declared configuration) | `dsh-executor-provider.ts` | the declared value is honored |
| D5 | A missing secret was reported as `PERMISSION_DENIED`, conflating "not configured" with "not permitted" | `secret-vault.ts` (`requireSecret`) | typed `SECRET_NOT_FOUND` / `SECRET_SOURCE_UNAVAILABLE` |
| D6 | Nothing ordered config → secrets → workspace → cwd → capabilities → authorization before the external call | — | the preflight below |

## 2. Secret boundary (contract §10-§16)

- **Pointer vs value.** `SecretRef` (core/ports/secrets.ts) is the durable-shape-safe form:
  which credential, from which source. It may be persisted, logged, projected and carried in
  evidence. A resolved value lives only in the call that produced it.
- **Typed fail-closed outcomes.** Two new core `ErrorCode`s: `SECRET_NOT_FOUND` (a ref names
  something not configured; remedy: set it) and `SECRET_SOURCE_UNAVAILABLE` (the keychain /
  vault could not be reached; remedy: repair the source). Distinct on purpose — an
  unreachable source must never read as "no secret needed", because a dead keychain and an
  empty configuration are the same answer with different meanings.
- **Pointer guard.** `assertSecretRefIsPointer` refuses a value smuggled through a ref field
  (length > 256, newlines, empty names, or `envName` on a non-env source) as
  `SECRET_REF_NOT_A_POINTER` — and never echoes the material it refused.
- **Central redaction.** `redactExecutionText` delegates to Core's `redactSecrets`, the one
  masking implementation in the system; `assertNoSecretMaterial` refuses a payload that
  carries material and reports only a length bucket (`guard: 'secret-material'`).
- **Local provider needs NO secret — proven.** Probed against the installed runtime:
  `env -i <node> lib/bin.js --profile headless --json "…PONG…"` → `{"type":"final","text":"PONG"}`;
  the same with an allowlist-only environment → `PONG`; `grep -rl "API_KEY|apiKey|api_key" lib/ config/`
  → no files. So no credential read, no env binding and no vault reference is built for the
  local dsh executor. The safety work is about NOT leaking, never about supplying, and no
  API-key requirement was fabricated to justify code.

## 3. Environment policy (contract §16, ARCH-033)

`buildExecutorEnvironment` (engine/executor/execution-safety.ts) is the executor's half of
the ONE environment law the repository already enforces for repository tools
(ADR-0028 D12):

- platform allowlist: Windows `PATH, PATHEXT, SystemRoot, WINDIR, TEMP, TMP`; POSIX
  `PATH, TMPDIR, LANG` plus `LC_` prefixes;
- declared additions are validated (name pattern, no NUL, no secret shape: the name list
  plus `/(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY|AUTH)/i`) and FAIL CLOSED;
- a declared addition may refine an allowlisted variable, never resurrect a dropped one;
- `...process.env` and `env: process.env` are banned in executor/adapter sources by
  ARCH-033 (guard + both-direction probes).

**Probed Windows fact (recorded, not assumed):** the host OS adds a fixed set of
system/session variables to every child block (HOMEDRIVE, HOMEPATH, LOGONSERVER,
SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR) that libuv
cannot suppress. The invariant is therefore stated precisely: *everything the child sees
came from our allowlist or from that fixed OS set*, and the adversarial parent values
(`S25_CANARY_SECRET`, `GITHUB_TOKEN`, `DSH_RUNTIME`) never cross. The real-smoke suite
asserts exactly that against a REAL child.

## 4. Configuration authority (contract §18-§21)

- **Typed schema** (`ExecutorConfigSchema`): `absolute-path`, `integer` (bounds),
  `boolean`, `string`. A required field with no value anywhere is
  `EXECUTOR_CONFIG_REQUIRED_MISSING` and names the environment variable to set; a
  non-absolute path is `EXECUTOR_CONFIG_PATH_NOT_ABSOLUTE`; an out-of-range integer is
  `EXECUTOR_CONFIG_RANGE`. An empty string never shadows a lower-precedence source.
- **Explicit precedence:** composition → named environment variable → declared default. Every
  effective field records its source (`executorConfigFieldOf`), so "where did this value come
  from" is answerable from the config object itself.
- **Fingerprint:** `scfg_<sha256[0:26]>` over `name=value@source` (sorted). A different
  source for the same value is a different fingerprint — provenance is part of identity.
- **Durability:** migration `0005_dispatch_config_fingerprint.sql` adds
  `provider_dispatches.config_fingerprint` (ARCH-006 amendment recorded here, same discipline
  as Sprint 24). It is NULL for history, and `recordConfigFingerprint` fills it in when a
  pre-Sprint25 binding resumes, so the NEXT resume can compare.
- **Drift safety:** a resumed attempt compares the recorded fingerprint against the current
  one. `drift` fails closed with `EXECUTOR_CONFIG_DRIFT` and the binding is marked UNCERTAIN;
  `match` proceeds; `no-history` is its own verdict — unknown is not "matched" and not
  "drifted", the resume proceeds (Sprint 24 parity) and records the current fingerprint so
  the unknown window closes immediately.

## 5. Workspace authority (contract §22-§28, ARCH-034)

- **Trusted root** (`resolveTrustedWorkspaceRoot`): absolute, exists, is a directory,
  canonicalized (realpath). It is an application-supplied value — never a model, provider,
  provider-stdout or task-payload value.
- **cwd check** (`assertExecutionCwdAllowed`): present → absolute → normalized
  (`resolve()` collapses `root\..\other` BEFORE the comparison) → contained by path
  component boundary (case-folded on Windows; `C:\work\foo` refuses `C:\work\foobar`) →
  canonical form still contained (a link pointing out is refused) → existing directory →
  no reparse/symlink escape on the way out of the root.
- **Request cwd travels with its root.** `ExecutorExecutionRequest.workspace` is
  `{ cwd, root? }`: the dispatch preflight proves both and hands them to the provider, and a
  provider that receives a requested cwd with no root to verify against refuses it. A
  composition-declared `fallbackCwd` is self-anchored (the composition asserts that exact
  directory) and is still existence/shape/reparse-checked per spawn.
- **Write boundary** (`assertWritePathWithinRoot`): the same containment, applied to a write
  target; a not-yet-existing target inside the root is legitimate.
- **What is NOT claimed.** This is an AUTHORIZATION boundary, not isolation. There is no
  sandbox, no container, no job object and no restricted token, and no document, test name or
  error message in this sprint claims otherwise. The TOCTOU window between "validated" and
  "spawned" is a real residual exposure: it is mitigated by re-validating per spawn (never
  caching a root) and by the trusted root living in a directory ordinary execution cannot
  rewrite — and it is stated here rather than denied.

## 6. The safety preflight (contract §29-§31)

**Where it sits in the canonical timeline (stated precisely, V2 closeout):** the preflight
occurs AFTER the canonical CompanyOS ExecutionAttempt claim is durably committed
(Transaction A: Task → RUNNING, ExecutionAttempt → ACTIVE, `Task.attempts += 1`), and
BEFORE any provider-side dispatch/publication or external side effect. It is a phase of
the stage handler that runs between Transaction A and Transaction B; it never creates,
moves or owns a claim. `provider_dispatches` (the subordinate provider-side binding) is
written only after the preflight passes, and the provider is invoked only after that —
outside any SQLite write transaction (ARCH-021/022, proven by `s25-claim-ordering.test.ts`).

The ordered phase, after the committed canonical claim and before every provider effect:

```
config-valid → secret-refs-resolvable → workspace-trusted → cwd-allowed
  → capabilities-supported → authorization-present
```

- A failure is a typed verdict: `{ safe: false, failedStage, error, stages }` where the
  stages are in contract order and the first failure ends the sequence (later stages are not
  evaluated — their inputs are not established).
- The orchestration turns a refusal into an ORDINARY failed outcome (`failed` with
  `failure: { stage, reason, code }`), NO provider_dispatches row, no provider call. The
  canonical claim (Transaction A) remains the durable record of the attempt that performed
  and failed the preflight; the engine settles
  the attempt through its existing transactions. There is no SafetyAttempt entity and no
  second lifecycle.
- Capability mismatch keeps Sprint 24's fail-loud `throw` (a routing mistake is a
  programming error); the preflight re-asserts the same fact idempotently for the verdict.
- **Authorization reuses the existing machinery.** `ProviderDispatchAuthorization` carries
  provenance, not a bare flag: `{ present, source: 'composition-policy' | 'decision-approval',
  reference }`. The desktop composition answers `composition-policy` (reference
  `provider-registration:<key>`) for an ordinary workspace-anchored dispatch, and for
  anything beyond that it must name an APPROVED approval from the existing run approval
  store (`approvedApprovalReferenceOf` scans the same approvals the `APPROVAL.GRANT`
  command writes). With neither, the dispatch fails closed at
  `authorization-present`.

## 7. Provider-specific protocol stays out of Core (§32)

`--profile headless`, `--json`, `--session-id` remain in the desktop adapter; the engine
receives an argv-building and result-parsing pair through the provider contract. No vendor
name and no provider flag enters engine sources (ARCH-031 unchanged).

## 8. What is preserved from Sprint 24 (§33)

`shell: false` always · `windowsHide` · 1 MiB bounded capture per stream with OUTPUT_LIMIT
tree termination · `taskkill /T /F` tree kill · composition-armed timer (the engine still
holds no timer) · the six-kind outcome taxonomy · SAFE-REPLAY (PUBLISHED/UNCERTAIN is never
re-invoked) · the subordinate dispatch binding · canonical settlement by the engine.

## 9. Tests (contract §43-§48)

| Suite | Tests | Proves |
|---|---|---|
| `s25-secret-boundary.test.ts` | 12 | pointer vs value, the two typed codes, report-without-values, central redaction, payload refusal without echoing |
| `s25-config-authority.test.ts` | 8 | precedence + source per value, required/absolute/range failures, empty-never-shadows, fingerprint determinism, source-sensitive fingerprint, drift verdict |
| `s25-workspace-safety.test.ts` | 13 | root canonicalization/refusals, child + root allowed, prefix-SIBLING refused, absolute traversal refused, canonical-escape refused, relative/missing/file/reparse refusals, platform case-folding, write boundary |
| `s25-preflight-pipeline.test.ts` | 20 | the six-stage order, each stage failing in isolation and stopping, env allowlist (canary/secret-shape/refine/name+value), a REAL filtered child, untrusted-cwd refusal before spawn, dispatch-level refusal with no row, drift handling, pre-Sprint25 parity + fingerprint recording, happy-path settlement, missing authorization |
| `s25-real-provider-smoke.test.ts` | 6 | typed config source, a REAL dispatch settling through all six stages, THREE consecutive real dsh invocations, the production default env policy over a real child, untrusted cwd refused before the real provider runs |
| `s25-claim-ordering.test.ts` (V2) | 6 | the canonical claim (Transaction A) is durable BEFORE the preflight (a probe reads Task RUNNING / attempt ACTIVE / attempts=1 at the instant the preflight runs); a preflight refusal makes ZERO provider calls and NO provider_dispatches row while keeping exactly ONE attempt truth; preflight failures consume attempts under the FROZEN retry semantics; the provider runs OUTSIDE any write transaction (a second connection writes the same file during the call); settlement after a refusal uses the existing canonical rules; a crash after the claim but before the preflight restarts onto the SAME attempt |
| architecture probes | +6 | ARCH-033 and ARCH-034 proven both directions |

Sprint 24 suites stay at 47 passing (fixtures migrated to the new preconditions: a typed
config, an authorization provenance, and a cwd that travels with its root).

## 10. Known limitations (honest)

1. TOCTOU: validated-then-spawned is a window, not a proof. Mitigated (per-spawn re-validation,
   non-rewritable root), not eliminated.
2. Windows adds its own fixed system variables to a child block; the child environment is
   bounded by our allowlist ∪ that OS set.
3. A dispatch binding with no recorded fingerprint (pre-Sprint25 history, or a hand-claimed
   row) has unknown provenance; the resume proceeds and records the fingerprint immediately.
4. The preflight proves the workspace root and its containment. It does not protect against a
   process that legitimately holds write access to the workspace root itself.
5. No secret storage, no keychain writer, no vault is added: the Sprint 6 vault is reused by
   reference only, and the local provider needs none.

## 11. Gap board (contract §59)

See `S25_GAP_BOARD.md`. CLOSED: SECRETS_CONFIG_WORKSPACE_SAFETY, SECRET_REFERENCE_BOUNDARY,
SECRET_NON_PERSISTENCE, CONFIG_AUTHORITY, CONFIG_DRIFT_SAFETY, TRUSTED_WORKSPACE,
PATH_ESCAPE_GUARD, EXECUTION_PREFLIGHT_SAFETY, SAFE_PROVIDER_ENVIRONMENT. OPEN (not this
sprint's scope): PRODUCT_CONTROL_PLANE, FINAL_SYSTEM_AUDIT, REAL_PROJECT_BUG_BASH.
