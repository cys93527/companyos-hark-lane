# BB-002 — Real Model Provider Recon

**Contract:** Boss V1 Product Reachability Closeout §8-§14 · **Baseline:** 433e111 · source-verified

---

## 1. Every ModelProviderPort implementation in the repository

| Implementation | Location | Classification |
|---|---|---|
| `MockProvider` | `packages/engine/src/providers/mock-provider.ts` | **TEST_ONLY / DETERMINISTIC_FIXTURE** — its own header: "a deterministic, vendor-free adapter used by tests and by the UI until a real adapter exists". Scripted by call index, no IO. |
| Inline stubs | `tests/**` (every composeCoreServices fixture: s20/s21/s26/final-audit/…) | **TEST_ONLY** — responseFormat-routed deterministic answers at the model seam, documented as controlled fixtures. |
| *(none other* | — | **PRODUCTION_SHIPPED: ZERO. REAL_ADAPTER: ZERO.** |

**Dynamic confirmation of the gap:** the production Desktop composition registers no
model provider at all; `goal.create` requires a company model selection
(`MODEL_SELECTION_REQUIRED` fail-closed, `control-plane.ts:386-404`), and with no real
adapter registrable from shipped code, a genuinely model-backed Planning/Supervisor
round is impossible without test-only injection. (BUG-BB-002 root cause.)

## 2. The exact frozen ModelProviderPort contract (`packages/core/src/ports/model-provider.ts`)

| Facet | Contract |
|---|---|
| **Input** | `InvocationRequest{modelId, messages[{role,content}], temperature?, maxOutputTokens?, responseFormat?, tools?, traceId?, signal?}` |
| **Output** | `InvocationResult{modelId, providerId, outputText, structured\|null, toolCalls[], usage{inputTokens,outputTokens,totalCost\|null}, finishReason, providerMeta?}` |
| **Text generation** | `outputText` on every success |
| **Structured generation** | `responseFormat: {mode:'json_object'\|'json_schema', schema?, schemaName?}` → parsed `structured`; Core validates the CONTRACT, adapter supplies the parse |
| **Timeout** | not a port field — adapter-bounded; maps to error kind `timeout` |
| **Cancellation** | `signal` MUST be propagated; fired ⇒ invocation ends with `err(DomainError('CANCELLED', …, {kind:'CANCELLED'}))` — never retried, never a second provider |
| **Usage** | `TokenUsage`; `totalCost` null when unknown |
| **Error taxonomy** | `PROVIDER_ERROR_KINDS`: rate_limited, quota_exhausted, timeout, context_limit, auth_failed, invalid_request, tool_unsupported, structured_output_unsupported, streaming_unsupported, unavailable, content_filtered, unknown — normalized, redacted, `retryable` flag, `retryAfterMs` |
| **Model identity** | `describe()` → `{providerId, kind, displayName, version}`; `listModels()` → `RawModelInfo[]` (modelId, contextWindow REQUIRED, capabilities partial, pricing) |
| **Configuration** | adapter-owned; the registry persists registrations + model records (`providers`/`provider_models`/`model_records` stores) |
| **Credential handling** | `secretRefs?(): SecretRef[]` — POINTER ONLY `{id, providerId, purpose, source:'env', envName}`; the registry's `secretResolver` is used ONLY for redaction; the adapter resolves its own secret in memory |
| **Session semantics** | NONE in the port — stateless single invocations; no conversation handle exists at this seam |
| **Tool semantics** | `tools` may be DECLARED by callers; `finishReason:'tool_calls'` + `toolCalls[]` exist for capable adapters |

## 3. Planner requirements (source: `packages/engine/src/planning/planner-runtime.ts`)

- ONE bounded pinned model turn (§16 comment: "structured-only, zero tools"); NO Planner
  Session, NO conversation (file header line 19).
- Token budget PRE-CHECK needs the bound model's `contextWindow` from the model
  catalogue (`deps.modelCatalog.contextWindowOf`) — the registered model record must
  carry a truthful context window.
- Output must satisfy the strict T20-02 plan-proposal validation; malformed ⇒
  `INVALID_OUTPUT` → the execution settles FAILED — never a plan (fail loud, no repair).
- Binding: run-snapshot model bindings (from the company selection at `goal.create`).

## 4. Supervisor requirements (source: S18/S21 supervisor + s21 fixtures)

- Bounded single turns with `responseFormat` JSON schemas:
  supervisor-verdict (`{verdict:'PASS'|…, findings[], missingRequirements[], targetRef}`
  for goal verdicts / `{verdict, findings, summary}` for reviews) and
  supervisor-action (`{action:'CONTINUE'|…, reasonCode, summary, evidenceRefs, subject{taskId}}`).
- Proposals only: the supervisor's output is VALIDATED and applied by the canonical
  runtime (decision sink / task events); the model can never mutate state directly.
- Zero tools; no session; every turn stateless (state rebuilt from canonical truth).

## 5. Architecture decision (Boss §9-§10 honored)

- `ModelProviderPort` (reasoning) and `ExecutorProvider` (execution) remain distinct
  contracts; neither implements the other; no `DshModelProvider` is built.
- The real adapter is CompanyOS-native at the adapter layer:
  `apps/desktop/src/models/openai-compatible-provider.ts` speaking the
  **OpenAI-compatible HTTP chat-completions dialect as an ADAPTER PROTOCOL** — a
  protocol choice, not a vendor dependency: `baseUrl`, model id, credentials and
  timeouts are deployment configuration, so compatible backends include remote
  providers, self-hosted endpoints and local gateways. No vendor name enters Core.

## 6. Safety rulings for the adapter (Boss §12-§14)

1. **Reasoning-only / no tool side effects:** the adapter NEVER sends `tools`; a caller
   that declares any receives a typed `tool_unsupported` refusal before any HTTP call.
2. **Stateless:** one HTTP request per `invoke`; no conversation/session handle is
   created, stored or surfaced; any upstream request id lives in `providerMeta`
   (diagnostic) and never becomes CompanyOS identity.
3. **Structured output fail-loud:** when `responseFormat` is requested, the response
   body text must parse as JSON — malformed ⇒ typed provider error
   (`invalid_request`, message "malformed structured output") — never repaired into
   business truth, never a mock fallback. Planner's own T20-02 validation stays the
   second, independent gate.
4. **Credentials:** `SecretRef{source:'env', envName:'COMPANYOS_MODEL_API_KEY'}`
   declared via `secretRefs()`; the value is resolved in memory by the
   composition-injected resolver (the existing vault) and appears nowhere durable.
5. **Cancellation/timeout:** `AbortSignal.any([request.signal, timeout])`; cancel ⇒
   `CANCELLED` DomainError; timeout ⇒ `timeout` kind; HTTP status mapping:
   401/403→`auth_failed`, 429→`rate_limited`(+retry-after), 5xx/网络→`unavailable`,
   400→`invalid_request`.
6. **Registration:** composition-root self-registration when the typed env config
   resolves (`COMPANYOS_MODEL_BASE_URL`, `COMPANYOS_MODEL_ID`,
   `COMPANYOS_MODEL_API_KEY`, optional `COMPANYOS_MODEL_TIMEOUT_MS`,
   `COMPANYOS_MODEL_PROVIDER_ID`) — mirroring the existing dsh executor
   self-registration seam; the renderer registers MODEL ROWS and the selection policy
   through the existing ops only (`models.register`, `models.policy`).

## 7. Live-validation state (Boss §18)

The only OpenAI-compatible credential discoverable on this machine is the DeepSeek
account key inside the DSH harness credential store, and it is currently rejected
upstream (401 — recorded `OPTIONAL_PROVIDER_UNAVAILABLE_AUTH`; not touched, per
contract §1). Therefore: deterministic implementation + real-protocol tests (a local
OpenAI-compatible HTTP fixture server exercising REAL sockets/JSON over the adapter)
are delivered; the LIVE external smoke is honestly reported as
`LIVE_MODEL_VALIDATION_BLOCKED_CONFIGURATION` until the user supplies a working
endpoint/key through the env seam. No mock substitution for the live smoke.
