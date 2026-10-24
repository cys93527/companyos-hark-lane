# Sprint25 — Gap Board (contract §59)

Targets closed by this sprint, each with the evidence that closed it. The three
remaining OPEN items are explicitly NOT this sprint's scope and are not claimed as
done anywhere in the repository.

## CLOSED (Sprint 25)

| Gap | Closed by | Evidence |
|---|---|---|
| `SECRETS_CONFIG_WORKSPACE_SAFETY` | the ordered six-stage safety preflight, a phase of the canonical attempt AFTER the committed ExecutionAttempt claim and BEFORE any provider-side dispatch/publication or external side effect (V2 closeout: ordering proven by `s25-claim-ordering.test.ts`) | `s25-claim-ordering.test.ts` (claim durable before preflight; zero provider calls; no second attempt truth; frozen retry semantics; no provider_dispatches row; provider outside write tx; canonical settlement; crash-after-claim restart) + `s25-preflight-pipeline.test.ts` (order + per-stage isolation + dispatch-level refusals with no provider_dispatches row); `EXECUTION_SAFETY_STAGE_ORDER` |
| `SECRET_REFERENCE_BOUNDARY` | `SecretRef` (pointer) vs a resolved value (memory transient), the pointer guard, and the names-only resolution report | `s25-secret-boundary.test.ts` tests 1–4, 8–10; `assertSecretRefIsPointer`, `reportSecretResolution` |
| `SECRET_NON_PERSISTENCE` | no value in any durable object, artifact, event, log or error detail; a carrying payload is refused with a length bucket only | `s25-secret-boundary.test.ts` test 12; migration 0005 carries a FINGERPRINT (a derivation over non-secret values), never a value; `provider_dispatches` has no secret column |
| `CONFIG_AUTHORITY` | typed validated schema + named precedence (composition → environment → default) + per-value source | `s25-config-authority.test.ts` tests 1–5; `resolveExecutorConfig`, `DSH_CONFIG_SCHEMA` |
| `CONFIG_DRIFT_SAFETY` | the dispatch records the configuration fingerprint it was claimed under; a resumed attempt refuses a drifted configuration | `s25-config-authority.test.ts` test 8; `s25-preflight-pipeline.test.ts` test 17 (drift → UNCERTAIN, no provider call) and test 18 (pre-Sprint25 parity + immediate provenance recording); migration 0005 |
| `TRUSTED_WORKSPACE` | the trusted root is application-supplied and canonicalized per spawn; a requested cwd must travel with the root it was derived from | `s25-workspace-safety.test.ts` tests 1–4; `resolveTrustedWorkspaceRoot`; `request.workspace = { cwd, root }` |
| `PATH_ESCAPE_GUARD` | component-boundary containment after normalization, plus reparse/symlink refusal and the write boundary | `s25-workspace-safety.test.ts` tests 5–13; `assertPathWithinCanonicalRoot` (shared with repository tools); ARCH-034 guard + both-direction probes |
| `EXECUTION_PREFLIGHT_SAFETY` | the six-stage ordered verdict, fail-closed, delivered as an ordinary failed outcome the engine settles — never a second lifecycle | `s25-preflight-pipeline.test.ts` tests 1–8, 16, 20; no `SafetyAttempt` entity exists in the schema or the code |
| `SAFE_PROVIDER_ENVIRONMENT` | the child environment is built by the allowlist policy (never the parent wholesale), proven against a REAL child and proven not to break the real provider | `s25-preflight-pipeline.test.ts` tests 9–13; `s25-real-provider-smoke.test.ts` (production default policy over a real child; real dsh answers with a sanitized environment); ARCH-033 guard + probes |

## OPEN (unchanged, explicitly not this sprint)

| Gap | Why it stays open |
|---|---|
| `PRODUCT_CONTROL_PLANE` | Product UI/control surface is not part of the safety contract; nothing in this sprint touches it. |
| `FINAL_SYSTEM_AUDIT` | The final audit is a separate deliverable; this sprint's own audits are the preflight, the guard and the smoke suite. |
| `REAL_PROJECT_BUG_BASH` | Running a real end-to-end project through the whole product is the bug-bash deliverable, not a safety-sprint deliverable. The real *provider* path is proven here (3 × 3 real dsh invocations), which is the safety-relevant slice. |
