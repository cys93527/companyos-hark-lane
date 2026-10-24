# Sprint24 — Real Provider Selection (§37)

Selection made AFTER recon (`S24_PROVIDER_EXECUTOR_RECON.md`); no guessing.

## Selected: DeepSeek Harness headless CLI (`dsh --profile headless`)

| Criterion | Evidence |
|---|---|
| Stable local automation interface | installed runtime `@deepseek-ai/dsh` 0.1.6-max with bundled node 24; `--help` documents the surface |
| Non-GUI | headless profile: one task → stdout → exit |
| Documented/inspectable protocol | NDJSON run events (`session`/`status` phase events with usage/`text`/`final`); exit code; stderr diagnostics |
| Bounded execution | answers one task and exits; bounded token usage reported per step |
| Detectable completion/failure | `{"type":"final"}` + exit 0; non-zero exit / `turn_end` reason carries failure kinds |
| Compatible workspace handling | spawned with an explicit cwd (trusted workspace or the runtime dir); no arbitrary default |

USER-SPECIFIED LOCAL RUNTIME CONSTRAINT: the installed DeepSeek Harness
(`E:\DeepSeek.Harness`, dsh 0.1.6-max, NOT the newest official version) is the
authoritative capability source for Sprint24 — never upstream. Decision provenance:
USER CONSTRAINT (this target) + EXECUTOR DISCOVERY (the probes below) + BOSS
ARCHITECTURE DECISION (the CompanyOS-native seam).

Live pre-selection probe (real external execution, sanitized):
`dsh --profile headless --json "Reply with exactly the word PONG."` →
NDJSON stream ending `{"type":"final","text":"PONG"}`, exit 0, usage
`{inputTokens:7010, outputTokens:3}`. Session identity
`session-a2fbcd24-…` persisted (resume-capable via `--session-id`).

## Rejected candidates

| Candidate | Reason |
|---|---|
| Codex CLI | not installed (only a Store installer exe at `E:\Codex`; no `codex` on PATH) — nothing to integrate |
| ZCode | contract §3 excludes it absent a documented automation interface; none exposed |
| OpenCode desktop | Electron app, no CLI on PATH |
| Git / Python / Node as the "real executor" | real and stable, but they are the PROCESS MECHANICS the generic provider wraps, not an agent-grade executor; kept as the generic provider's verification targets and as the honest fallback if dsh is unavailable on another machine |

## Provider capability truth (advertised by the adapter)

`timeout`, `structured-output` (NDJSON), `working-directory`, `stdin`,
`external-run-identity` (session id), `recovery-resume` (`--session-id`
continuation), `streaming-diagnostics` (NDJSON events), `cancellation`
(kill-tree REQUEST — proof of stop only via exit evidence).
NOT advertised (negotiated loudly, never silently degraded): `status-query`,
`idempotency-key` (dsh mints a new session per invocation — CompanyOS-side
deterministic dispatch keys remain OUR binding identity, never a provider
exactly-once claim), `environment-inputs`, `continuation-beyond-resume`.
