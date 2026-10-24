# Sprint24 — Provider/Executor Recon (no production changes before this)

Baseline `e4cc6e7`. Audited seams and the real local runtime landscape.

## Existing CompanyOS seams (audited)

| Seam | Current state | Sprint24 use |
|---|---|---|
| Engine handler registry (`deps.handlers.resolve(kind, branch)`) | exact-kind map; missing kinds fail closed at materialization | unchanged — the provider dispatch runs INSIDE a registered StageHandler |
| Engine three-transaction timeline (`engine.ts` claim tx A → handler window → settlement tx B) | Sprint21 final; ARCH-021/022 guarded | unchanged — provider invocation happens in the handler window (outside any write tx, after the durable claim) |
| ExecutionAttempt (`core/lifecycle/execution-attempt.ts`, `execution_attempts` store) | deterministic `exa_` identity, claim/transition/listByTask | the dispatch binding is SUBORDINATE to it (attempt_id FK + attempt_number mirrored, never deciding anything) |
| AgentExecution (`agent_executions`) | model provenance | NOT reused for provider claims (a non-model shell never fabricates one) |
| Model registry / providers / modelBindings | composition-level registration | untouched (model path unchanged) |
| Process execution utilities | `repository/repository-process-runner.ts`: spawn(shell:false, windowsHide, detached), filtered env, 8MiB stream cap with OUTPUT_LIMIT termination, `taskkill /pid /T /F` tree kill on Windows, AbortSignal-aware | pattern source for the generic `ProcessExecutorProvider` (same primitives, smaller surface) |
| Cancellation | AbortSignal conventions throughout (supervisor forwards into agent units) | single cancellation channel = the same AbortSignal reaching the provider; request ≠ proof |
| Workspace/cwd | Sprint17 canonical workspace root + path policy; repository runner spawns only in the canonical root | provider takes a trusted cwd or FAILS CLOSED (no arbitrary default) |
| Timeout | repository runner bounded; supervisor timeoutMs | explicit bounded timeout; termination only proven by process evidence |
| Receipts/events | supervisor-application artifacts; `events` feed (task.state_changed, approvals) | unchanged; dispatch durability is the new provider binding |
| Artifact/Evidence sinks | ArtifactService + CAS; findings/validation sinks | provider result evidence goes through the SAME envelope the engine already settles (no second truth) |
| RunObservationService | S23 read-only projections | extended with provider facts (read-only) |
| Desktop composition (`core-services.ts`) | handler buckets `executorKinds/reviewKinds/qaKinds` (trusted registration data) | new provider-backed bucket + the dsh adapter (vendor names are banned in engine — the adapter lives here) |
| Reference capability map | DeepSeek Harness = SELECTIVE ADAPTATION (S23) | Sprint24 mechanisms recorded (§55 update) |

## Real local runtime landscape (probed, evidence recorded)

| Candidate | Interface found | Verdict |
|---|---|---|
| **DeepSeek Harness (dsh CLI)** | installed at `E:\DeepSeek.Harness\DeepSeek Harness`; ships `resources/runtime` (`@deepseek-ai/dsh` 0.1.6-max, bin `dsh`) + bundled node 24; `dsh --profile headless [--json] [--session-id <id>] "<task>"` — one task, NDJSON run events (`session`,`status`,`text`,`final`), exit code, session id = persisted external identity, `--session-id` adopts (resumes) an existing session. LIVE PROBE: `--json "Reply with exactly the word PONG"` → `{"type":"session",...}` … `{"type":"final","text":"PONG"}`, exit 0, usage 7013 tokens | **SELECTED** (stable, non-GUI, documented, bounded, detectable completion, session identity + continuation) |
| Codex CLI | `E:\Codex` contains only a Store installer exe; no `codex` binary on PATH; `codex --version` not found | REJECTED (no installed automation interface) |
| ZCode | Electron app; no documented stable automation surface exposed | EXCLUDED per contract §3 |
| OpenCode desktop | Electron app; no CLI on PATH | REJECTED |
| Local process runtime (git 2.47.1 / python 3.14 / node 24) | real OS processes, stable CLIs | the generic ProcessExecutorProvider mechanics target; used by the mock/verification providers and available as a fallback real executor |

## Consequences for design

1. The engine gets the vendor-neutral **contract** (`ExecutorProvider`, capabilities,
   typed outcomes, deterministic dispatch key) + a generic **process provider**; the
   **dsh adapter** lives in the desktop composition (engine bans vendor names).
2. The durable **provider dispatch binding** needs one new table — the legitimate
   ARCH-006 amendment path (recorded in the law doc inventory), guarded by the same
   putGuarded conventions, UNIQUE(dispatch_key) = deterministic idempotency.
3. dsh truthfully advertises: timeout, structured-output (NDJSON), working-directory,
   stdin, external-run-identity (session id), recovery-resume (`--session-id`),
   streaming-diagnostics, cancellation (kill-tree REQUEST — proof only via exit
   evidence). It does NOT advertise status-query or provider-side idempotency keys —
   those absences are negotiated loudly, never degraded silently.
