# Hark lane roadmap — PRODUCT_TARGET / COMPARISON_ACCEPTANCE coverage

Source of truth for scope: `pkg/handoff/PRODUCT_TARGET.md`, `COMPARISON_ACCEPTANCE.md`,
`DEVELOPMENT_STRATEGY.md`, `SECURITY.md`. Status words: DONE (Hark self-review PASS,
not independent review), NEXT, BLOCKED(<who must approve / provide>), NOT RUN.

| # | Target item | Stage | Status |
|---|---|---|---|
| 1 | Native Job Object bounded lifecycle (3B-3E) | H1, H3–H5 | DONE (self-review); independent review pending |
| 2 | Supervisor contract for native jobs | H6 | DONE contract; production wiring BLOCKED(user approval + independent review) |
| 3 | Output capture / structured output | H7 | DONE |
| 4 | Installable per-user Windows build + install/uninstall smoke | H8 | DONE on CI; real user PC NOT RUN (user); signing BLOCKED(paid) |
| 5 | Replaceable Provider, real model call | H9 | DONE (1 DeepSeek call, CI) |
| 6 | Trusted price / budget proof / cost authorization | H10 | DONE layer: operator-attested proof source + cap (CNY 1) + live planning Goal (H10b) |
| 7 | Goal/Plan/Run/Task/Attempt trusted state, real progress + cost visible to the boss | H11 | DONE read-only view (run.budget); was: renderer shows budget cap / reserved / settled / UNKNOWN; budget approval UI (renderer cannot grant trust: approval written by main-process operator action only) |
| 8 | Persistence recovery: restart consistency, cancel terminal not overwritten, no auto-replay of UNKNOWN paid call | H12 | DONE (self-review) on CI: hark-restart 40198306740 @c233140, 3 processes on installed app, fake provider; UNKNOWN reconciliation flow NOT designed |
| 9 | Installer upgrade / downgrade / data-retention policy | H13 | NEXT: CI install v0.1.0 → v0.1.1 → uninstall, userData retained per policy |
| 10 | Controlled real tools / DSH runtime, actual file Artifact/CAS/Validation/Handoff on a real goal | — | BLOCKED(user: approved DSH runtime source + licence; native.job production wiring approval) |
| 11 | Windows file/network isolation (beyond Job Object) | — | BLOCKED(user: ACL/firewall/account changes approval) |
| 12 | Ordinary-user desktop acceptance, same-device comparison with Codex lane | — | BLOCKED(user + independent reviewer) |
| 13 | Ubuntu gate where applicable | H14 | NEXT: run full offline gate on ubuntu CI (no secrets) |
| 14 | tag / release | — | BLOCKED(user) |

Rules carried by every stage: keep first failures, never add counts across runs,
NOT RUN/UNKNOWN/BLOCKED never become PASS, self-review is never independent review.
