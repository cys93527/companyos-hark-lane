> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Security Model (Threat Model and Controls)

| Field | Value |
|---|---|
| Document | SECURITY_MODEL.md — assets, trust boundaries, STRIDE threats, sandbox, secrets, audit, supply chain |
| Scope | CompanyOS V1.1 desktop application (Phase 0/1 in detail; P2–P4 controls flagged by sprint) |
| Baseline decisions | ADR-0010 (Electron contextIsolation + typed IPC), ADR-0012 (local-first, single user), ADR-0003 (`node:sqlite`), ADR-0011 (no agent framework in Core) |
| Review cadence | Threat table re-reviewed **every sprint**; §13 acceptance checklist signed at the end of each sprint |
| Owner | Security Reviewer (ARB), with the Principal Architect accountable for boundary integrity |

---

## 1. Assets

| # | Asset | Where it lives | Why it matters | Primary loss impact |
|---|---|---|---|---|
| A1 | **Org knowledge (semantic memory)** | `memory_records` + `artifacts/` | The accumulated value of the product; hard to reconstruct | Loss of institutional knowledge; privacy harm if exfiltrated |
| A2 | **Workflow definitions (`WorkflowVersion.graph`)** | `workflow_versions` | The SOPs the company runs on; the reproducibility contract | Integrity loss invalidates runs and audit |
| A3 | **Published version hashes (`contentHash`)** | `workflow_versions`, `run_snapshots` | The immutability/reproducibility anchor | A forged hash breaks the entire audit story |
| A4 | **Run history & event log** | `runs`, `node_executions`, `events`, `checkpoints` | Operational truth, incident forensics, metrics | Tampering ⇒ undetectable bad decisions; deletion ⇒ audit failure |
| A5 | **Audit log (hash-chained)** | `audit_log` | Non-repudiable record of who did what | Tamper ⇒ accountability collapse |
| A6 | **Handoff envelopes & artifacts** | `handoffs`, `handoff_dedupe`, `artifacts/` | Inter-role work products; may embed sensitive content | Duplicate effects; data exposure |
| A7 | **Secrets (model API keys, signing keys, credentials)** | OS keychain via `SecretResolver` | Direct cost and blast-radius risk | Credential theft; financial loss |
| A8 | **Local identity & authority grants** | `Org` tables | Determines who may approve/decide | Privilege escalation |
| A9 | **The SQLite file itself** | `%APPDATA%\CompanyOS\companyos.db` | Contains A1–A6, A8 | Single-file exfiltration |
| A10 | **Industry Pack code** | `packs/*` (installed bundle) | Executes with declared capabilities | Malicious/trojaned pack = full local compromise |
| A11 | **Model provider channel (P2+)** | outbound network | Data egress point | Sensitive prompt/content exfiltration |
| A12 | **Build/CI pipeline & release artifacts** | GitHub Actions, lockfile, dist | Supply-chain entry point | Backdoored release |
| A13 | **User's machine account** | OS | Ultimate trust anchor | Full compromise (out of scope beyond defence-in-depth) |
| A14 | **Telemetry/crash data (if enabled)** | opt-in only, external | Privacy surface | Re-identification; leakage of org content |

---

## 2. Trust boundaries

```text
TRUST BOUNDARY MAP (untrusted → trusted, moving inward)

  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │ B1  RENDERER  (untrusted UI)                                                         │
  │     React 19 + Vite · sandbox: true · nodeIntegration: false · contextIsolation: true │
  │     MAY: render, hold UI state, call window.companyos.invoke(channel, payload)        │
  │     MUST NOT: fs, node:*, SQLite handle, dynamic channel names, eval, remote code     │
  └───────────────────────────────────┬──────────────────────────────────────────────────┘
                                      │  ══ B2  PRELOAD BRIDGE ══
                                      │  frozen object · static channel allow-list
                                      │  zod request+response schemas · no node: exposure
  ┌───────────────────────────────────▼──────────────────────────────────────────────────┐
  │ B3  MAIN PROCESS  (trusted)                                                          │
  │     composition root · owns DB path · owns SecretResolver · CSP + navigation guards  │
  │     every IPC handler: validate → authorize → dispatch → map Result/typed error       │
  └───────┬───────────────────────────────┬──────────────────────────────┬───────────────┘
          │                               │                              │
          │ ══ B4  PACK BOUNDARY ══       │                              │
          ▼                               ▼                              │
  ┌───────────────────────┐   ┌───────────────────────────┐             │
  │ INDUSTRY PACK CODE    │   │ WORKER POOL               │             │
  │ declared capabilities │   │ no DB handle              │             │
  │ least privilege ·     │   │ requests writes via port  │             │
  │ code-review gated     │   │                           │             │
  └───────────┬───────────┘   └────────────┬──────────────┘             │
              │                            │                            │
              └────────────┬───────────────┘                            │
                           ▼                                            ▼
                ┌────────────────────────────┐          ══ B5  NETWORK BOUNDARY ══
                │ SQLITE FILE (companyos.db) │          ┌──────────────────────────┐
                │ main process access only   │────P2+──►│ MODEL PROVIDER (external)│
                │ plaintext in P0/P1 (§9)    │          │ egress allow-list, no    │
                │ secrets NEVER stored here  │          │ restricted data (§6.1)   │
                └────────────────────────────┘          └──────────────────────────┘
```

| ID | Boundary | Threat posture | Enforced by |
|---|---|---|---|
| B1 | Renderer (untrusted UI) | Treat all renderer input as hostile; the renderer is also the surface where model-influenced content (P2+) will render | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP, navigation guards (§5.3) |
| B2 | Preload bridge | The **only** legal crossing; no dynamic channel names, no object pass-through that proxies `node:` | typed channel registry + zod schemas (§5.4) |
| B3 | Main process | Trusted, but least-privilege internally: every handler validates then authorizes | handler template + Governance `PolicyEvaluator` |
| B4 | Industry Pack code | Semi-trusted: verified by code review, constrained by declared capabilities at runtime | `PackManifest.permissions` + capability sandbox (§7) |
| B5 | Model provider (external) | **Untrusted channel**; assume everything sent may be retained/observed; assume responses may be adversarial/hostile content | egress allow-list, sensitivity gate, output treated as data (§6.1, §12 T-14) |
| — | SQLite file | Trusted storage in P0/P1 (OS-level protection only); encryption roadmap §9 | single-writer main process; no plaintext secrets |

---

## 3. STRIDE-style threat table

Severity: **H** = high, **M** = medium, **L** = low. Sprint = the sprint by which the control must be in place.

| ID | STRIDE | Threat | Affected boundary | Control | Severity | Sprint |
|---|---|---|---|---|---|---|
| T-01 | Spoofing | A renderer-side script impersonates a human decision and calls an approval channel with a fabricated `decidedBy` | B1 → B2 | `decidedBy` is **never** taken from the renderer; it is derived from the local identity in the main process. Approval handlers additionally require the envelope's `idempotencyKey` and an `AuthorityGrant` check | H | 1 |
| T-02 | Spoofing | A malicious Industry Pack registers a capability under a trusted `contractId`, intercepting work meant for core/another pack | B4 | Capability registration is name- and source-checked: a pack may only register capabilities declared in its own manifest; `contractId` collisions are refused at startup with an audit entry | M | 3 |
| T-03 | Tampering | Direct edit of `companyos.db` to alter `workflow_versions.graph` or `contentHash` | SQLite file | Immutability trigger `trg_version_immutable` + `snapshot.verify` recompute ⇒ `HASH_MISMATCH`; periodic integrity sweep samples 5% of content hashes | H | 1 |
| T-04 | Tampering | Edit of the audit log to remove an inconvenient entry | SQLite file / A5 | Append-only table + hash chain (`prev_hash`, `entry_hash`); chain verification on startup and on every Nth append; a break is reported loudly, never repaired | H | 2 |
| T-05 | Tampering | Model output (P2+) contains instructions that make the app write/execute something ("prompt injection into tool use") | B5 → B1/B3 | Model output is **data**: never `eval`'d, never used to construct a channel name, never interpreted as a command; tool invocations require a declared capability + schema validation + policy gate. A model can only request; Governance authorizes | H | 2 (design) / P2 (impl) |
| T-06 | Tampering | Plugin/pack ships an update that quietly broadens permissions | B4 | Permissions are declared in `PackManifest` and compared on every load; a **widened** permission set requires explicit user re-consent + audit entry | H | 3 |
| T-07 | Repudiation | A user denies having approved a gate | B2/B3 | Every decision writes an `audit_log` entry with actor, envelope digest, decision, timestamp, and the hash-chained predecessor | M | 2 |
| T-08 | Repudiation | A handoff effect is applied twice and the dispute cannot be resolved | B3/B4 | Outbox + dedupe table: `handoff_dedupe` rows are evidence of exactly-once application; duplicate deliveries are logged with the recorded result | M | 5 |
| T-09 | Information disclosure | Malware or another local user reads `companyos.db` (plaintext in P0/P1) and exfiltrates org knowledge | SQLite file | P0/P1: file resides in the per-user `%APPDATA%` with OS ACLs; UI states plainly that data is unencrypted. §9 roadmap: `safeStorage`-derived DB key → SQLCipher | **H** | 1 (mitigation/docs), 4–6 (encryption) |
| T-10 | Information disclosure | Secrets appear in logs, crash dumps, or the DB | B3/all | `SecretResolver` only source; secrets never persisted to SQLite; log redaction allow-list + secret-pattern scan (§4.2); a unit test seeds a canary secret and asserts it never reaches any sink | H | 1 |
| T-11 | Information disclosure | Renderer navigates to a remote page (or an `about:blank` popup) and thereby inherits bridge/privileges | B1/B2 | CSP (`default-src 'self'`), `will-navigate` deny-by-default, `setWindowOpenHandler` returns `{action:'deny'}` for all external URLs; external links open in the OS browser via an explicit allow-listed handler | H | 1 |
| T-12 | Information disclosure | Memory retrieval leaks `confidential`/`restricted` records to a lower-clearance caller | B3 → Memory | Deny-by-default sensitivity filter inside the store implementation; over-broad `sensitivityAtMost` is clamped; denied results are indistinguishable from absent records (`docs/MEMORY_ARCHITECTURE.md` §6.1) | H | 4 |
| T-13 | Information disclosure | Cross-org read (a query returns another org's records) | Memory / B3 | `orgId` scoping enforced in the store layer, not the caller; isolation test M-15 | M | 4 |
| T-14 | Information disclosure | Prompt/PII egress to an external model provider (P2+) | B5 | Egress allow-list; per-call sensitivity declaration; `restricted` never sent without an audited explicit policy; provider opt-in only | H | P2 |
| T-15 | Information disclosure | Telemetry/crash reporter leaks org content by default | A14 | Telemetry is **opt-in only, off by default**; payloads are content-free by construction (codes, counts, durations); a pre-send scrubber validates against the redaction allow-list (§10) | M | 2 |
| T-16 | Denial of service | Handoff ping-pong (A↔B) burns budget and blocks the run | B3/B4 | `constraints.maxHops` bound (default 3) + circuit breaker after 5 consecutive dead-letters per `(toRole,intent)` (`docs/HANDOFF_PROTOCOL.md` §3.2 R-6) | M | 5 |
| T-17 | Denial of service | Untrusted input causes an unbounded DB write or an FTS query storm from the renderer | B1 → B3 | zod `limit` caps on every list/query channel; FTS term/length caps; per-run budget; the renderer cannot request an unbounded scan | M | 1 |
| T-18 | Denial of service | Run queue saturation by repeated run creation | B3 | Policy gate + per-org concurrency cap; refusals are typed (`POLICY_DENIED`), not silent queueing | L | 2 |
| T-19 | Elevation of privilege | A renderer script calls an internal channel not exposed in the allow-list | B1 → B2 | Preload exposes a **static** frozen map; unknown channels throw at the bridge before reaching main; a lint rule bans dynamic channel-name construction | H | 1 |
| T-20 | Elevation of privilege | Prototype pollution via a crafted IPC payload mutates the bridge or Core objects | B2 → B3 | zod `.strict()` schema validation (no unknown keys) + `Object.create(null)` payload copies + `structuredClone` at the boundary; no `__proto__`/`constructor` propagation | H | 1 |
| T-21 | Elevation of privilege | Pack code escapes its declared capabilities (e.g. reads a file without `fs.read`) | B4 | Capability sandbox: packs receive only the handles listed in `PackManifest.permissions`; direct `node:`/`fs` imports are banned by the pack lint profile | H | 3 |
| T-22 | Elevation of privilege | Malicious dependency in the supply chain gains code execution at build or runtime | A12 | Lockfile committed and frozen in CI; `pnpm audit` gate; dependency allow-list for Core; provenance/attestation for releases; licence scan (§11) | H | 1 |
| T-23 | Elevation of privilege | Unsigned/tampered pack bundle is loaded | B4 | `PackManifest.signature` advisory in V1.1 (dev mode) and **required from P4**; until then, packs are loaded only from the reviewed local `packs/` tree | H | 3 (review gate), P4 (signing) |
| T-24 | Tampering | Migration file edited on disk to alter schema/history | SQLite file | `schema_migrations` checksum verification; mismatch ⇒ **refuse to open the DB** (`MIGRATION_CHECKSUM_MISMATCH`), never auto-repair | M | 1 |
| T-25 | Spoofing | IPC response forged by a compromised renderer preload injection | B2 | Response schemas validated in main **and** in the renderer; the bridge object is frozen (`Object.freeze`) and built from a module-private map | M | 1 |
| T-26 | Information disclosure | Sensitive content in `payload` of a handoff that is later archived/exported | B3 | 8 KiB inline limit + artifacts referenced by `contentRef` with inherited sensitivity; export honours sensitivity; `restricted` payloads are refused inline | M | 5 |
| T-27 | Repudiation | Silent DLQ discard destroys evidence of a failed handoff | B3 | DLQ rows are never deleted; `discard` requires an operator reason and leaves the row with `status='discarded'` | L | 5 |
| T-28 | Tampering | Backup file edited before restore | SQLite file | Backup integrity: an optional backup manifest with per-table digests + `audit_log` chain verification after restore; encrypted backups required when `restricted` data exists (§9.4) | M | 4 |
| T-29 | Spoofing | Stolen OS account yields full DB access | A13 | Out of scope for the app to prevent fully; mitigations: OS ACLs, optional app lock (`safeStorage`-protected unlock secret), encryption roadmap §9 | H | 4–6 (partial) |
| T-30 | Information disclosure | Renderer devtools/extension reads bridge payloads and reveals sensitive content to a shoulder-surfer/extension | B1 | Sensitive fields are not sent to the renderer unless displayed; devtools disabled in production builds; CSP blocks extension injection vectors | M | 2 |

---

## 4. Secrets handling

### 4.1 Rules

| # | Rule |
|---|---|
| S1 | **Single source:** all secrets are read through the `SecretResolver` port (CANONICAL_SPEC §4). No module reads an env var, config file, or keychain directly. |
| S2 | **Storage:** secrets live in the **OS keychain** (Windows Credential Manager / macOS Keychain / libsecret) via Electron `safeStorage` (DPAPI/Keychain-backed) as the fallback tier. |
| S3 | **Never in SQLite.** No secrets column exists anywhere. A `secret_handle` (an opaque key id) may be stored; the value never is. |
| S4 | **Never in logs.** Enforced by the redaction allow-list (§4.2) plus a canary test (seed a secret, assert absence in every sink). |
| S5 | **Never in memory records or handoff payloads.** Memory may hold a handle only (`docs/MEMORY_ARCHITECTURE.md` §6.1). |
| S6 | **Never in error messages.** Errors carry a code and a redacted context object; `SecretResolver` failures report the *keyId*, never the value. |
| S7 | **Renderer never sees a secret.** The renderer may request an *action* that uses a secret (e.g. "test provider connection"); the value stays in main. |
| S8 | **Least privilege + rotation:** secrets are scoped per provider; rotation is a UI action; a rotated secret's old value is overwritten in the keychain, and rotation is audited (keyId + timestamp, not value). |
| S9 | **Memory hygiene:** resolved secrets are held in a short-lived variable, not attached to long-lived objects; a `wipe()` helper zeroes buffers where the platform allows. |
| S10 | **Redaction is default-deny:** a value is logged only if it matches the allow-list; everything else is `<redacted>` by field-name policy, then scanned for patterns. |

### 4.2 Redaction allow-list

`REDACTION_ALLOWLIST` is a single, centrally enumerable constant in `@companyos/platform` (FR-14). Two mechanisms combine:

1. **Field-name policy (deny by default):** any key matching `/pass(word|phrase)?|token|secret|api[-_]?key|private[-_]?key|authorization|cookie|session|credential|signature|salt/i` is replaced with `"<redacted>"` at any depth.
2. **Value-pattern scan (defence in depth):** strings matching known shapes — `sk-[A-Za-z0-9]{16,}`, `AKIA[0-9A-Z]{16}`, `gh[pousr]_[A-Za-z0-9]{20,}`, `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`, PEM blocks (`-----BEGIN … PRIVATE KEY-----`), 32+ char base64/hex runs adjacent to a secret-like key — are replaced with `<redacted:pattern:NAME>`.

**Explicitly allowed to log (allow-list):** `traceId`, `runId`, `orgId`, `envelopeId`, `idempotencyKey` (it is an id, not a secret), `eventId`, `recordId`, `contentRef` (a hash), `templateId`, `versionId`, `semver`, `errorCode`, `machine`, `from`, `event`, `durationMs`, `state`, `scope`, `sensitivity`, counts and byte sizes, and non-sensitive display names explicitly marked `@loggable` at the schema level.

### 4.3 Example redacted JSON log line

```json
{"ts":"2026-01-12T09:14:03.221Z","level":"info","logger":"core.execution.handoff","msg":"handoff dispatched","traceId":"01JG7P0000000000000000000A","runId":"01JG7P9A1B2C3D4E5F6G7H8J9K","orgId":"01JG7N0000000000000000000B","envelopeId":"01JG7Q2K3M4N5P6R7S8T9V0W1X","fromRole":"archetype.planner","toRole":"archetype.builder","intent":"work.produce","attempt":1,"state":"dispatched","contentRef":"sha256:9a1f…c7","bytes":41233,"providerApiKey":"<redacted>","authorization":"<redacted>","note":"using <redacted:pattern:OPENAI_KEY> for provider","durationMs":12,"outcome":"ok"}
```

Notes: the two keyed fields were redacted by **field-name policy**; the embedded key inside `note` was caught by **value-pattern scan**; every identifier in the line is on the allow-list. A test (`security.redaction.spec.ts`) asserts this exact shape and that a canary secret placed in a payload never appears in any sink.

---

## 5. Sandbox policy

### 5.1 Window / process configuration (mandatory, asserted by a startup self-check)

```ts
// apps/desktop/src/main/window.ts  — normative configuration
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,        // REQUIRED — renderer JS cannot touch preload scope
    nodeIntegration: false,        // REQUIRED — no require()/process in the renderer
    sandbox: true,                 // REQUIRED — OS-level renderer sandbox
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    devTools: !app.isPackaged,     // devtools only in development builds
    preload: PRELOAD_PATH,
  },
});
```

A startup self-check asserts these flags and refuses to open a window (with a diagnosable error screen) if any of them is wrong — a misconfiguration is a hard failure, not a warning (ADR-0010).

### 5.2 Content Security Policy

| Directive | Value | Rationale |
|---|---|---|
| `default-src` | `'self'` | Deny everything not explicitly allowed |
| `script-src` | `'self'` (`'unsafe-inline'` **only** in dev for Vite HMR, never in production) | Block injected scripts |
| `style-src` | `'self' 'unsafe-inline'` | React/Vite injects styles; inline *script* remains banned |
| `img-src` | `'self' data: blob:` | Local images only |
| `connect-src` | `'self'` in P0/P1; **explicit provider origins only** from P2 | No silent egress |
| `object-src` | `'none'` | No plugins |
| `frame-ancestors` | `'none'` | No framing |
| `base-uri` | `'none'` | Prevent base-tag hijacking |
| `form-action` | `'none'` | No form navigation |
| `worker-src` | `'self' blob:` | Worker pool only |

Delivered as an HTTP header via `session.defaultSession.webRequest.onHeadersReceived` (and mirrored in the dev server config so dev/prod do not diverge).

### 5.3 Navigation and popup guards

```ts
app.on('web-contents-created', (_e, contents) => {
  // 1. Block any navigation away from the app origin.
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url)) { event.preventDefault(); logBlockedNavigation(url); }
  });
  // 2. Deny all window.open / target=_blank, with one reviewed exception path.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowlistedExternalUrl(url)) { void shell.openExternal(url); } // opens in OS browser
    return { action: 'deny' };
  });
  // 3. Block webview / permission abuse.
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // deny-by-default
});
```

Rules: the allow-list of external URLs is a **static, reviewed list** (documentation links only); permission requests (camera, mic, geolocation, notifications, clipboard-write) are denied by default and enabled only for a named feature with a documented need.

### 5.4 IPC allow-list design

```ts
// packages/ipc/src/registry.ts — single source of truth for the bridge
export const CHANNELS = {
  'workflow.template.create': { req: TemplateCreateReq, res: ResultOf(TemplateCreateRes) },
  'workflow.template.get':    { req: TemplateGetReq,    res: ResultOf(TemplateGetRes) },
  'workflow.publish':         { req: PublishReq,        res: ResultOf(PublishRes) },
  'workflow.fork':            { req: ForkReq,           res: ResultOf(ForkRes) },
  'run.create':               { req: RunCreateReq,      res: ResultOf(RunCreateRes) },
  'run.cancel':               { req: RunCancelReq,      res: ResultOf(RunCancelRes) },
  'memory.query':             { req: MemoryQueryReq,    res: ResultOf(MemoryQueryRes) },
  'handoff.decide':           { req: HandoffDecideReq,  res: ResultOf(HandoffDecideRes) },
  'secret.testConnection':    { req: SecretTestReq,     res: ResultOf(SecretTestRes) }, // value never crosses B2
} as const;
export type ChannelName = keyof typeof CHANNELS;   // compile-time closed set
```

| Rule | Detail |
|---|---|
| Static registry | Channel names are a **closed literal union**. Asking for a name not in the union is a TypeScript error; at runtime the bridge throws `UNKNOWN_CHANNEL` before main is reached. |
| No dynamic names | A lint rule bans `invoke(anything-but-a-literal-channel-constant)` and any template-literal channel construction. |
| Validation both ways | zod `.strict()` on the request in main (unknown keys rejected) and on the response in the renderer. |
| Payload copying | Payloads are `structuredClone`d into null-prototype objects at the boundary to defeat prototype pollution (T-20). |
| Frozen bridge | The preload object is `Object.freeze`d and built from a module-private map; no property is a getter that could be re-entered. |
| Explicit errors | Handlers map Core `Result` errors to typed envelopes `{ok:false, code, machine?, message}` — never a stack trace, never a raw SQL error. |
| Timeouts | Every channel has a handler timeout; a hung handler returns `TIMEOUT` rather than blocking the renderer indefinitely. |
| Audit | Mutating channels (publish, fork, run.create, handoff.decide, secret.*) additionally append an audit entry in main. |
| Least privilege | Read channels and mutate channels are separate; a UI surface that only lists templates cannot call `workflow.publish`. |

---

## 6. Model-provider boundary (design fixed now; implementation P2)

| Aspect | Rule |
|---|---|
| Trust | The provider is an **untrusted external channel**: assume requests are retained and responses can be adversarially crafted. |
| Egress allow-list | `connect-src` names explicit provider origins; no wildcard, no user-supplied URL. |
| Sensitivity gate | Every call declares the maximum sensitivity it transmits; `restricted` requires an audited explicit policy per call (`docs/MEMORY_ARCHITECTURE.md` §6.1). |
| Output handling | Model output is **data**: never `eval`'d, never interpolated into a channel name, never treated as a command; it may only *request* a capability, which Core/Governance then authorizes (T-05). |
| Keys | Held only via `SecretResolver`; the renderer receives a keyId, not a value. |
| Budget | Every call is bounded by `HandoffBudget` / run budget; overspend is refused, not truncated. |
| Audit | Provider id, model id, token counts, and cost are audited; prompts and completions are **not** logged unless the user explicitly enables a local, redacted transcript (off by default). |
| Offline default | No provider configured ⇒ P0/P1 behaviour, fully offline (ADR-0012). |

---

## 7. Pack capability sandboxing

| Control | Detail |
|---|---|
| Declared capabilities | `PackManifest.permissions: PackPermission[]` (`fs.read`, `fs.write`, `net`, `secret`, `spawn`) with scopes. **Undeclared ⇒ denied at runtime**, not merely discouraged. |
| Least privilege | Scopes are narrow: `fs.read: ['<packdir>/**']` not `['**']`; `net` lists exact origins; `secret` lists key ids. |
| Handle-only access | A pack receives capability *handles* (narrow objects) from the composition root — never the `fs` module, never `process`, never a DB handle. |
| Static lint profile | Packs are linted with a profile banning direct `node:fs`, `node:child_process`, `node:net`, `electron`, `node:sqlite` imports. |
| Runtime guard | Capability calls are brokered and logged; a violation emits a security event and disables the pack for the session. |
| Code review gate | A pack may not be merged or loaded from a non-reviewed path without: (1) full diff review by the Security Reviewer, (2) permission-diff review against the previous version, (3) a test proving undeclared capability use fails. |
| Startup validation | Manifest validated by `pack-sdk` (zod); invalid ⇒ pack disabled entirely (no partial load), audit entry written. |
| Update consent | A version whose permission set **widens** requires explicit user re-consent and an audit entry (T-06). |
| Signature | Advisory (`sha256` digest, dev mode) in V1.1; **required** from P4 marketplace (T-23). |
| Isolation ceiling | Packs run in-process in V1.1 with capability brokering. Documented residual risk: in-process packs can burn CPU; a future out-of-process pack host is the P4 upgrade path. |

---

## 8. Data protection at rest

### 8.1 Current state (Phase 0/1)

| Data | Protection today | Residual risk |
|---|---|---|
| `companyos.db` | Per-user OS ACLs under `%APPDATA%\CompanyOS`; app-lock optional | **Plaintext** — local malware / another account with access can read it (T-09) |
| `artifacts/` | Same directory ACLs | Plaintext |
| Backups | A file copy; user-managed | Plaintext unless the user encrypts it |
| Secrets | OS keychain via `SecretResolver` | Correct tier already |

The UI must state the at-rest situation plainly (no false assurance) and offer the encryption roadmap as it lands.

### 8.2 Encryption roadmap

| Phase | Step | Mechanism | Exit criterion |
|---|---|---|---|
| Sprint 4 | **Field-level protection for `restricted`** | Encrypt `restricted` `memory_records.summary`/`contentRef` payloads with a key protected by Electron `safeStorage` (DPAPI/Keychain) | A `restricted` record's plaintext is absent from the DB file (verified by a byte scan test) |
| Sprint 5 | **Key management** | `SecretResolver`-backed master key; per-org data key wrapped by the master; rotation supported and audited | Rotation test with zero data loss; no key value in the DB |
| Sprint 6 | **Whole-file encryption** | Evaluate **SQLCipher**-compatible build vs. application-layer encryption over `node:sqlite` (a native SQLCipher build conflicts with ADR-0003's "no native compilation" and must not be adopted without a superseding ADR) | ADR filed with measured startup/perf impact; chosen path implemented behind `@companyos/persistence` |
| P4 | **Enterprise** | Managed key escrow, per-user keys, team sync with server-side encryption | Out of scope for V1.1 |

Constraint: **no encryption work may break ADR-0003 without a superseding ADR.** Prefer application-layer encryption over a native SQLCipher requirement; the `EntityStore<T>` port means this swap is adapter-local.

### 8.3 Key handling

| Rule | Detail |
|---|---|
| Keys never in SQLite | Only wrapped blobs or key ids; the master key lives in `safeStorage`/OS keychain |
| Unlock model | App-lock optional in V1.1; when enabled, a user passphrase unlocks the master key. Forgetting it means losing encrypted data — stated explicitly in the UI |
| Rotation | Supported; rotation is audited (key id + time); old wrapped blobs are re-wrapped in a background job that is resumable |
| Crash safety | A partially re-wrapped set is recoverable: both keys remain valid until the job completes and is marked done |

### 8.4 Backup encryption

| Rule | Detail |
|---|---|
| Default | Backups are a copy of `companyos.db` + `artifacts/`. If any `restricted`/`confidential` record exists, the UI **requires** an encrypted backup destination or refuses to create the backup. |
| Integrity | A `backup-manifest.json` with per-table row counts and content digests; verified on restore. |
| Restore verification | After restore, verify the `audit_log` hash chain and re-verify a 5% content-hash sample; a failure aborts the restore and preserves the original files. |
| Secrets | **Excluded** from backups by construction (they are in the OS keychain); a restore on a new machine requires re-entering secrets. |

---

## 9. Audit log requirements

| Requirement | Detail |
|---|---|
| Append-only | `audit_log` has `INSERT` only. A DB trigger denies `UPDATE` and `DELETE`; the repository exposes no mutating method. |
| Tamper-evident | Hash chain: `entry_hash = sha256(prev_hash || canonical(entry))`. The first entry uses a fixed genesis hash. Any edit breaks every subsequent hash. |
| Verification | Chain verification runs on startup and after every 100 appends; a break is **reported loudly** (blocking banner + audit-of-the-audit entry) and is never auto-repaired. |
| Content | `{occurredAt, actor, action, target, detail, traceId, prevHash, entryHash}`; `detail` is redacted by §4.2 before persistence. |
| Coverage (minimum) | lifecycle publish/revise/fork/deprecate/archive; lock acquire/release/sweep; proposal open/decide/consume; run create/cancel/terminal; handoff decision (approval gates); every `restricted` memory read; secret read/rotate; pack load/permission change; IPC config change; chain verification results; backup create/restore. |
| Retention | Forever (never purged) — audit is the accountability substrate. |
| Export | Audit export is read-only, redacted, and carries the chain so a third party can verify continuity. |
| Privacy tension | Audit records ids and actions, not content; where content is needed for accountability, a `contentRef` + hash is recorded instead of the content itself. |

---

## 10. Privacy and telemetry

| Rule | Detail |
|---|---|
| Local-first default | No network call is required for any P0–P2 capability (ADR-0012). "Offline by default" is a *product property*, not a setting. |
| Telemetry | **Opt-in only, off by default**, with a first-run explicit choice; no dark patterns; revocation is a single toggle that takes effect immediately. |
| Content-free by construction | Telemetry payloads carry codes, counts, durations, versions, platform, and feature flags — never memory content, prompts, workflows, names, or file paths. |
| Pre-send scrubber | Every telemetry payload passes the §4.2 redaction scan **and** a structural allow-list check; an unexpected key aborts the send (fail-closed). |
| Crash reports | Local by default; upload only with telemetry enabled; the report is redacted and its contents are viewable by the user **before** sending. |
| Provider egress | Distinct from telemetry, and separately controlled (§6). |
| Deletion | A user-triggered "delete all data" removes DB, artifacts, logs, and (if applicable) keychain entries; the action is itself audited locally only. |
| Data residency | Local-first means the user's file system is the residency boundary; no implicit cloud component exists to disclose. |

---

## 11. Supply-chain controls

| Control | Detail | Gate |
|---|---|---|
| Lockfile | `pnpm-lock.yaml` committed; CI uses `--frozen-lockfile`; a lockfile diff without a `package.json` diff fails review | CI (every PR) |
| Vulnerability scan | `pnpm audit --prod --audit-level=high` in CI; a HIGH/CRITICAL in a runtime dependency blocks the merge | CI |
| Licence scan | Automated SPDX scan; disallowed licences (GPL/AGPL-family for runtime deps, unknown licences) block; exceptions need a written ARB decision | CI |
| Dependency allow-list for Core | Core may depend on `@companyos/contracts` only (ADR-0011); any addition is an ADR | `check-boundaries.mjs --deps` |
| Provenance | Release artifacts built in CI from a tagged commit, with an SBOM (`cyclonedx` JSON) and a build attestation attached to the release | Release job |
| No postinstall scripts | `pnpm config set ignore-scripts` for CI installs of third-party deps; a dependency requiring a native/postinstall step is rejected (ADR-0003) | CI |
| Version pinning | Exact versions for runtime deps; ranges only for dev tooling | Review |
| Pack provenance | Packs come from the reviewed `packs/` tree; signature required from P4 | §7 |
| Secrets in CI | OIDC/short-lived credentials only; no long-lived tokens in the repo; secret scanning enabled on the repository | CI config |
| Reproducibility | Node version pinned via `engines` + CI matrix; lockfile + SBOM enable a reproducible rebuild | Release |

---

## 12. Incident response and disclosure

| Phase | Action | Owner / Timeline |
|---|---|---|
| **Detect** | Sources: audit-chain break alarm; integrity sweep mismatch; redaction canary failure; boundary-check failure; dependency advisory; user report | Automated + any contributor |
| **Triage** | Classify severity **S1** (data loss/exfiltration, chain break, RCE), **S2** (integrity of workflows/versions, capability escape), **S3** (localized DoS, UI exposure), **S4** (cosmetic/low) | Security Reviewer, within 1 business day |
| **Contain** (S1/S2) | Disable the affected capability (e.g. unload the pack, disable the provider), preserve evidence (copy DB + logs + audit chain), do not "fix forward" before preserving | Principal Architect, immediate |
| **Eradicate** | Root-cause; a fix requires a regression test that fails without it | Owning engineer |
| **Recover** | Restore from a verified backup if integrity is lost; re-verify the audit chain; publish an internal post-mortem | Security Reviewer |
| **Communicate** | S1/S2: notify affected users with impact, scope, and remediation; maintain a local `SECURITY_INCIDENTS.md` log (no secrets, no user data) | ARB |
| **Post-mortem** | Blameless, written within 5 business days; adds at least one automated control (test, lint rule, or CI gate) so the class cannot recur | ARB |
| **Disclosure** | Researchers may report privately to the maintainer address listed in `SECURITY.md`; acknowledgement within 3 business days, triage within 10, coordinated public disclosure after a fix ships (default 90-day window, earlier by mutual agreement if the fix is verified) | Maintainer |
| **Safe harbour** | Good-faith research against a local, self-owned instance is welcome; testing against third parties' data is not. The scope statement is published in `SECURITY.md` | Maintainer |

---

## 13. Security acceptance checklist (verified at the end of every sprint)

Each item is binary and evidence-backed. A sprint is **not** done if any applicable item fails (`pnpm check` green is necessary but not sufficient).

| # | Check | Evidence | Applies |
|---|---|---|---|
| C-01 | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in the shipped window config, asserted by a startup self-check | config diff + self-check test log | every sprint |
| C-02 | CSP delivered in prod build with `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; no `'unsafe-inline'` in `script-src` | response-header test | every sprint |
| C-03 | `will-navigate` blocked; `setWindowOpenHandler` denies by default; webview attach blocked; permission requests denied by default | unit tests for each handler | every sprint |
| C-04 | Every IPC channel is in the static registry; no dynamic channel name exists (lint rule green) | lint output + `grep` for `invoke(` with non-literal args | every sprint |
| C-05 | Every IPC request/response validated by a zod `.strict()` schema; unknown keys rejected | per-channel tests | every sprint |
| C-06 | Payloads cloned into null-prototype objects at the boundary; a prototype-pollution attempt is rejected | security test | every sprint |
| C-07 | A canary secret never appears in any log sink, DB row, telemetry payload, or error message | redaction canary test | every sprint |
| C-08 | `REDACTION_ALLOWLIST` unchanged or change-reviewed; exact redacted log-line snapshot matches §4.3 | snapshot test | every sprint |
| C-09 | No secret value is persisted to SQLite anywhere (scan + schema has no secret column) | schema review + byte scan test | every sprint |
| C-10 | Secrets read only through `SecretResolver` (no direct env/config/keychain reads) | import scan | every sprint |
| C-11 | `audit_log` has no `UPDATE`/`DELETE` path; DB triggers present; hash chain verifies | trigger test + chain verification log | from Sprint 2 |
| C-12 | Every state-changing command writes exactly one audit entry (where §9 requires it) | coverage test | from Sprint 2 |
| C-13 | Lifecycle immutability holds: a published version cannot be mutated (`trg_version_immutable` fires) | trigger test | from Sprint 1 |
| C-14 | `HASH_MISMATCH` / `SNAPSHOT_MISMATCH` paths fail loudly with no auto-repair | tests F04/F05/F06 analogues | from Sprint 1 |
| C-15 | Migration checksum mismatch refuses to open the DB | migration test | from Sprint 1 |
| C-16 | 8/8 forbidden nouns absent from Core; boundary self-test passes; zero allow-list entries | `boundary-report.json` | every sprint |
| C-17 | Core dependency set is `@companyos/contracts` only | `check-boundaries.mjs --deps` output | every sprint |
| C-18 | `pnpm audit` and the licence scan pass with no HIGH/CRITICAL and no disallowed licence | CI logs | every sprint |
| C-19 | Lockfile frozen; no postinstall-driven native builds | CI config + install log | every sprint |
| C-20 | No model call, no network call, and no `EmbeddingProvider` implementation exist in the Phase 0/1 code paths | architecture test `memory.embedding.absent` + egress test | every sprint through P1 |
| C-21 | Pack manifests validate; undeclared capability use fails; a widened permission set requires re-consent | pack sandbox tests | from Sprint 3 |
| C-22 | Sensitivity filtering is deny-by-default and clamped; cross-org reads return zero records | M-12/M-13/M-15 logs | from Sprint 4 |
| C-23 | Telemetry is off by default; a telemetry payload contains no content fields; revocation takes effect immediately | telemetry tests + default settings snapshot | from Sprint 2 |
| C-24 | Backup of data containing `restricted` records is refused unless encrypted; restore re-verifies the audit chain | backup tests | from Sprint 4 |
| C-25 | Threat table (§3) re-reviewed this sprint; every new control has a test and every accepted residual risk is recorded | review record + updated table | every sprint |
| C-26 | No Sprint-6-forbidden scope exists (no Model Router, Agent Runtime, DevCompany, Coding Agent, Workflow Designer, 多模型调度) | repo tree audit | every sprint |
| C-27 | `SECURITY.md` (disclosure policy, safe harbour, maintainer contact) present and current | file review | every sprint |

**Sign-off:** Security Reviewer + Principal Architect. An unmet **H**-severity control without a recorded, time-boxed remediation plan blocks the sprint from being declared done (CANONICAL_SPEC §8: `pnpm check` green + docs + handoff + commit, and here additionally the security checklist).
