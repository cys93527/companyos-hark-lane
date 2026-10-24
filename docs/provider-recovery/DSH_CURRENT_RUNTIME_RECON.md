# DSH Current Runtime Recon — V1 Real Executor Compatibility Recovery

**Baseline:** 74089c99596ef67bff19f48ac1fe79691ddcfa6b · READ-ONLY recon (no CompanyOS change before this document)

**Runtime under test (the exact one bound to CompanyOS):** `E:\DeepSeek.Harness\DeepSeek Harness\resources\node\node.exe` + `resources\runtime\lib\bin.js` (`@deepseek-ai/dsh` `0.1.6-max`, bin.js SHA256 `69c49c87…`)

---

## 1. Probe log (all bounded; every probe followed by process-tree kill + port check)

| # | Probe | Result | Elapsed | Evidence |
|---|---|---|---|---|
| A | `dsh --help` | launcher help; **advertises** `dsh headless "run the tests" — answer one task, print the result, and exit` | <1s | exit 0 |
| B | `dsh headless --help` | prints the **WEB app's** usage (`Usage: dsh --profile web — Serve the DeepSeek Harness browser UI`); spawns market service on :18899; exits 0 | <1s | exit 0; port released after tree exit |
| C | `dsh help headless` | invalid form (`profile "help" does not exist`) — not a supported syntax | <1s | stack trace |
| D | **`dsh headless "Reply with exactly the word PONG"`** (the EXACT advertised form) | `error: too many arguments. Expected 0 arguments but got 1`; spawns market service; **hangs** until the 120 s bound | 121 s (killed) | exit killed; port released after kill |
| E | `dsh companyos-recon-hl --json "Reply with exactly the word PONG"` (profile created via shipped template) | **FULL S24 CONTRACT**: NDJSON `session`(id)→`status`→`text`→`final` `"PONG"` | **3 s** | exit 0; **no** :18899 spawned |
| F | same profile `--json --session-id <E's session>` continuation | SAME sessionId, turn 2, `"PONG"` (repeats prior answer) | 3 s | exit 0 |
| G | same profile WITHOUT `--json` | plain text `PING` | <5 s | exit 0 |

Environment observations: `~/.dsh` exists with a user layer; `~/.dsh/profiles/headless/package.json` (mtime today) additionally lists experimental agent-team bundles, but `--dump-config` vs `--dump-default-config` for profile `headless` are **byte-identical** (600 lines) — the user layer's extras contribute nothing; the composition difference comes from the runtime itself (below).

## 2. Root cause (read from the installed runtime's own source)

`resources/runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`:

```js
const PROFILE_TEMPLATES = {
  web:      { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
  headless: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },   // shipped template — the S24 composition
  ...
};
/** Installation-owned bundle tuples normalized to the shipped template. */
const INSTALLATION_OWNED_PROFILE_TUPLES = { headless: [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",     // ← the installation composes web-app INTO the named headless profile
  "@deepseek-ai/dsh-headless"
] };
```

The named `headless` profile is **normalized by the installation** to include the web-app layer; the web app occupies the app slot, rejects positional task arguments (`Expected 0 arguments`), does not know `--json`, and starts the plugin-market service (:18899) then serves forever. The one-task contract lives on in the **shipped template composition** (`[base, dsh-headless]`), reachable under any profile name that is NOT installation-normalized — proven by probes E/F/G. Version label `0.1.6-max` is identical across both behaviors → **the version string cannot select the protocol**.

## 3. Contract matrix (FROZEN S24 vs CURRENT INSTALLED)

| Field | Frozen S24 | Current installed (named `headless`) | Current installed (template-restored profile) | Verdict |
|---|---|---|---|---|
| Task invocation syntax | `--profile headless [flags] "<task>"` | task argument rejected at parse | `<profile> [flags] "<task>"` **works** | CHANGED (named) / UNCHANGED (template path) |
| Headless mechanism | one task → NDJSON → exit | web server boots, hangs | one task → NDJSON → exit | as above |
| Structured output | `--json` NDJSON events | `unknown option '--json'` | **identical NDJSON contract** (`session`,`status`,`text`,`final`) | UNCHANGED on template path → **CURRENT_STRUCTURED_OUTPUT_SUPPORTED** |
| Session identity | `"type":"session","sessionId":…` | none reachable | identical, fresh ids | UNCHANGED |
| Session continuation | `--session-id` adopts SAME session for NEW work | none reachable | **verified** (probe F: same id, turn 2) → SUPPORTED | UNCHANGED |
| Provider invocation identity | not exposed by runtime | — | not exposed → never invented | UNCHANGED (absent) |
| Same-invocation recovery | NOT provided | — | NOT provided | UNCHANGED (absent) |
| Working directory | request cwd honored | — | `cwd` echoed in session event | UNCHANGED |
| Cancellation / timeout | external kill-tree | n/a (hangs) | bounded; CompanyOS kill-tree unchanged | UNCHANGED (CompanyOS side) |
| Diagnostics | stderr + status events | web logs | identical event shape | UNCHANGED |
| Exit semantics | 0 on completed turn | 0 after `--help`; hang on task | 0 on completed turn | UNCHANGED on template path |

## 4. Port 18899 / process lifecycle (§14)

- Required by the headless task contract? **NO** — the template composition (probes E/F/G) never spawns the market service; it belongs to the web-app layer.
- Spawned unnecessarily? Only under the web-app-composed (installation-normalized) profile.
- Residue after successful task? None observed (template path never opens it).
- Residue after timeout-kill? None observed — the listener dies with the process tree (netstat clean after every probe, including D's kill).
- CompanyOS obligation: keep depending only on its own kill-tree (already the case — process provider tree-kill); nothing reads :18899; residue can never become CompanyOS truth (no code path references it — audited).

## 5. Classification (§7)

**B. CURRENT_DSH_HEADLESS_HEALTHY_INTERFACE_CHANGED**

The runtime is healthy and the ENTIRE frozen S24 contract (including `--json`, session identity and continuation) executes verbatim — but the invocation path changed: the named `headless` profile is installation-normalized to a web-app composition; the contract is reachable via a profile composed from the shipped headless template under a non-normalized name.

**Version label sufficient to select protocol: NO** (same `0.1.6-max`, two different interfaces — proven by probes B/D vs E).

## 6. Recovery design (adapter/config layer ONLY — §9)

1. `DSH_CONFIG_SCHEMA` gains optional `profileName` (kind `string`, default `companyos-headless`, env `DSH_PROFILE`).
2. Adapter `baseArgv` uses the configured profile: `[bin.js, --profile, <profileName>, --json]`.
3. Post-hoc contract-mismatch classification: when an outcome carries captured text matching the KNOWN drift signatures (`unknown option '--json'` / `too many arguments` / `profile "…" does not exist`), the adapter reclassifies to `provider-failed` with `reasonCode: 'EXECUTOR_DSH_PROFILE_CONTRACT_MISMATCH'` and a remediation hint (create the profile from the shipped template). These signatures are PROOF of parse-level non-invocation — never a coercion of malformed output; everything else (including genuine unknowns) keeps the frozen uncertainty semantics.
4. One-time operator setup (documented, deterministic): `dsh companyos-headless --from-default-profile headless` (or point `DSH_PROFILE` at any template-conformant profile). This is OPERATOR_SETUP of the external runtime (same category as installing DSH), not a product workaround.
5. Config-fingerprint impact: `profileName` becomes a resolved field → new dispatches fingerprint differently from pre-fix rows; a resumed pre-fix attempt refuses with the frozen drift rule (fail-closed, honest). No V1 production database predates this change (Bug Bash has not run).

Not touched (frozen): Task/ExecutionAttempt/registry/preflight/settlement/Observation/Control Plane semantics; Core contains no DSH names/flags/shapes; continuation ≠ recovery; no providerInvocationId invention; unknown outcome + no idempotency proof → UNCERTAIN, no automatic replay.
