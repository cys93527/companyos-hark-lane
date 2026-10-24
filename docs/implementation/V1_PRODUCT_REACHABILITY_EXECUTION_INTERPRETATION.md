# V1 Product Reachability — Execution Interpretation

**Document Type:** Implementation-first interpretation (created before any production change)
**Contract:** Boss "V1 PRODUCT REACHABILITY CLOSEOUT — COMPANYOS-NATIVE PROVIDER ARCHITECTURE"
**Baseline:** 433e111d38cfd43df80f272756639db0e4232c75 (working tree verified CLEAN)

---

## 1. Exact repo baseline

`433e111` = `fix: restore current dsh provider compatibility`. All statements below were
read from source at this baseline (source is canonical; no name was mapped by similarity).

## 2. Exact files expected to change

| File | Change class |
|---|---|
| `apps/desktop/src/production-composition.ts` | **NEW** — the single named production wiring seam (shared by main.ts and tests) |
| `apps/desktop/src/main.ts` | BB-001 — both core-composition sites consume `productionCompositionOptions()` |
| `apps/desktop/src/models/openai-compatible-provider.ts` | **NEW** (BB-002) — the real ModelProviderPort adapter (OpenAI-compatible HTTP as adapter protocol) |
| `apps/desktop/src/core-services.ts` | BB-002 — composition-root self-registration of the model adapter when its typed config resolves (mirrors the existing dsh executor self-registration seam) |
| `docs/bug-bash/BB002_REAL_MODEL_PROVIDER_RECON.md` | **NEW** — §8 recon |
| `tests/production/*.test.ts` | **NEW** — BB-001/BB-002 regression + negative + independence proofs |
| `docs/architecture/ARCHITECTURE_LAWS.md`, `scripts/check-architecture.mjs`, `tests/architecture/architecture-laws.test.ts` | §22 — new law(s) + guard + both-direction probes |
| `docs/INDEX.md` | index rows for new docs |

No Core/engine domain file changes; no migration; no new table.

## 3. Canonical owners involved (unchanged by this task)

Goal/Plan/WorkflowVersion/Run/Task/ExecutionAttempt/Decision/Artifact/Evidence/Validation/
Recovery/Handoff/Outcome — all owners frozen as audited (docs/final-audit). Providers of
either class remain subordinate capability adapters; none gains business authority.

## 4. Existing provider abstractions found (source-verified)

- **`ExecutorProvider`** (`packages/engine/src/executor/executor-provider.ts`) — external
  execution capability; registry = `createExecutorProviderRegistry`; routing per task kind
  via composition options `providerKinds` + `providerRoutes` (`core-services.ts:804,1085`);
  Sprint25 preflight + `provider_dispatches` subordinate binding unchanged.
- **The one shipped executor adapter** = `apps/desktop/src/executor/dsh-executor-provider.ts`
  (`dsh-headless`; typed env config `DSH_NODE/DSH_RUNTIME/DSH_PROFILE`; self-registers in
  the composition when its config resolves — `core-services.ts:2547-2556`).
- **Executor dispatch execution** = `apps/desktop/src/executor/provider-dispatch.ts`
  (`createProviderDispatchExecution`): claim → six-stage preflight → provider → settlement.

## 5. Existing model abstractions found (source-verified)

- **`ModelProviderPort`** (`packages/core/src/ports/model-provider.ts`) — reasoning/generation
  capability. Contract: `describe/listModels/health/invoke/stream` (+ optional
  `secretRefs(): SecretRef[]`); `InvocationRequest{modelId, messages, temperature,
  maxOutputTokens, responseFormat(json_object|json_schema), tools, traceId, signal}`;
  `InvocationResult{outputText, structured, toolCalls, usage, finishReason, providerMeta}`;
  normalized error kinds `PROVIDER_ERROR_KINDS` (auth_failed/rate_limited/timeout/…);
  cancellation MUST end the invocation (`CANCELLED` DomainError, never retried).
  The file's own header states the intended shape: "an adapter in the outer ring maps a
  real HTTP/JSON dialect onto these types".
- **`SecretRef`** (`packages/core/src/ports/secrets.ts`) — `{id, providerId, purpose,
  source:'env', envName}`; pointer-only, never the value; `createEnvSecretVault`
  (engine) resolves `COMPANYOS_`-prefixed env values, memory-only, authority-checked.
- **Registry** (`packages/engine/src/providers/registry.ts`) — explicit-id binding with
  persistence, capability normalization, error normalization, secret redaction
  (`secretResolver` used ONLY for redaction; adapters resolve their own secrets).
- **Model catalogue + selection** — `createModelRegistry` (`models.register/…`) and
  `createSelectionPolicyService` (`policies.savePolicy`, MANUAL company selection);
  the Control Plane's `goal.create` derives run model bindings from the company
  selection (`control-plane.ts:386-404`, fail-closed `MODEL_SELECTION_REQUIRED`).
- **Shipped renderer surface** — `models.register / models.enable / models.policy /
  models.refreshHealth` ops (`workflows.ts:1135-1304`); NO provider-adapter
  registration op exists (adapters are composition-root code — correct).

## 6. Current production Desktop composition path

`apps/desktop/src/main.ts`:
- **Main product composition** (line 182-194, `buildWorkflowApi`): passes
  `repositoryRuntime: { repositoryCapableKinds: [] }` and
  `stageHandlers: { executorKinds: [GOAL_WORK_KIND] }` — **no `providerKinds`, no
  `providerRoutes`** (empty route table by default, `core-services.ts:804`), and no
  repository capability. The comment already documents the INTENT ("the product
  composition registers the pinned-agent executor for it — trusted deployment
  declaration — the same seam tests use") — the wiring is simply absent.
- **Quiescent startup composition** (line 599-603): conservative shell for recovery;
  re-used as the product instance when the database is up at boot (single composition,
  `buildWorkflowApi` reuses `coreServices` when the db matches) — therefore BOTH sites
  must carry the same production wiring.

**Why shipped Desktop cannot reach an executor today:** the work kind's stage handler
resolves its provider through the composition route table; with no route the dispatch
fails (fail-closed) — there is no route to any adapter under normal product
configuration. This is BUG-BB-001's root cause (a wiring gap at the deployment seam,
not a missing abstraction).

## 7. Current model selection/config path

Composition builds `providers`/`models`/`policies` (`core-services.ts:610-645`); the
renderer registers model rows and sets the MANUAL company policy through the existing
ops; `goal.create` reads the policy. **No real adapter implementation exists to
register** — the only `ModelProviderPort` implementation in the repository is
`packages/engine/src/providers/mock-provider.ts` (header: "deterministic, vendor-free
adapter used by tests and by the UI until a real adapter exists"). This is BUG-BB-002.

## 8. Current executor selection/config path

`DSH_NODE/DSH_RUNTIME/DSH_PROFILE` env → typed adapter config → self-registration into
the ONE `ExecutorProviderRegistry`; routing per kind via composition `providerRoutes`
(the seam BB-001 wires). No renderer authority anywhere in this path.

## 9. Invariants that must remain unchanged

1. CompanyOS owns Goal/Plan/WorkflowVersion/Run/Task/ExecutionAttempt/Decision/
   Artifact/Evidence/Validation/Recovery/Handoff/Outcome — no provider of either class
   may create/settle/own any of them.
2. `ModelProviderPort` = reasoning; `ExecutorProvider` = external execution; the two
   contracts stay distinct (no reimplementation of one atop the other).
3. No vendor name (DSH/OpenAI/Codex/ZCode) enters Core/Planner/Supervisor/Control Plane
   semantics. The OpenAI-compatible HTTP dialect is an ADAPTER PROTOCOL only
   (configurable baseUrl ⇒ any compatible backend: remote, self-hosted, local gateway).
4. The model adapter is reasoning-only: it never sends tools (typed refusal if a caller
   declares any), never writes files/runs commands/touches Git or the workspace.
5. Stateless single-request model calls for V1 planning/supervisor; any external session
   identity is diagnostic-only and never becomes CompanyOS truth.
6. Malformed model output FAILS LOUD (typed) — never repaired into business truth, no
   MockProvider fallback, no invented Plan fields.
7. Raw credentials never persist (SecretRef pointer only), never appear in logs/events/
   Artifacts/Evidence/renderer; values live in memory via the existing vault.
8. Missing/unconfigured providers fail loud with typed states; no silent mock, no fake
   execution, no claimed Task completion, no invented Artifact/Evidence.
9. No second truth/task system/workflow/scheduler/queue/session-authority/artifact
   store/validation system/provider registry/config truth/secret store (§21).
10. All frozen audit invariants (docs/final-audit) and ARCH-001..036 stand.

## 10. Explicit non-goals

- No Bug-Bash projects A/B/C (separate order).
- No DSH credential debugging; DSH stays ONE optional executor adapter
  (current auth state recorded as OPTIONAL_PROVIDER_UNAVAILABLE_AUTH).
- No ZCode/Codex adapters (separate scope).
- No latest-DSH/Codex/Paperclip/Jev research.
- No renderer provider authority; no UI routing truth.
- No change to Task/ExecutionAttempt/preflight/settlement/Observation semantics.
- No V1 freeze/tag/push.

## Terminology verification note

`planExecutionBindings` (a `ComposeCoreServicesOptions` field, `core-services.ts:367`) is
declared but unused in the composition body — run model bindings actually come from
`lifecycle.createRun({modelBindings})` driven by the company selection
(`control-plane.ts:386-404`). The BB-001 wiring therefore does NOT touch
`planExecutionBindings` (dead option, left as-is; noted, not removed — out of scope).
