# Hark lane roadmap — PRODUCT_TARGET / COMPARISON_ACCEPTANCE coverage

Source of truth for scope: `pkg/handoff/PRODUCT_TARGET.md`, `COMPARISON_ACCEPTANCE.md`,
`DEVELOPMENT_STRATEGY.md`, `SECURITY.md`. Status words: DONE (Hark self-review PASS,
not independent review), NEXT, BLOCKED(<who must approve / provide>), NOT RUN.

| # | Target item | Stage | Status |
|---|---|---|---|
| 1 | Native Job Object bounded lifecycle (3B-3E) | H1, H3–H5 | DONE (self-review); independent review pending |
| 2 | Supervisor contract for native jobs | H6, H15b | DONE contract; production wiring H15b (user approved 2026-10-26) — Job-backed native.job registered from packaged deployment data, see H15_AGENT_KERNEL_NATIVE_JOB.md; independent review pending |
| 3 | Output capture / structured output | H7 | DONE |
| 4 | Installable per-user Windows build + install/uninstall smoke | H8 | DONE on CI; real user PC NOT RUN (user); signing BLOCKED(paid) |
| 5 | Replaceable Provider, real model call | H9 | DONE (1 DeepSeek call, CI) |
| 6 | Trusted price / budget proof / cost authorization | H10 | DONE layer: operator-attested proof source + cap (CNY 1) + live planning Goal (H10b) |
| 7 | Goal/Plan/Run/Task/Attempt trusted state, real progress + cost visible to the boss | H11 | DONE read-only view (run.budget); was: renderer shows budget cap / reserved / settled / UNKNOWN; budget approval UI (renderer cannot grant trust: approval written by main-process operator action only) |
| 8 | Persistence recovery: restart consistency, cancel terminal not overwritten, no auto-replay of UNKNOWN paid call | H12, H12b | DONE (self-review) on CI: hark-restart 40198306740 @c233140; H12b typed cancel terminal (FAILED/cancelled → CANCELLED projection, migration 0009, startup cancel convergence, fenced boss reads) — see H12B_TYPED_CANCEL_TERMINAL.md; H12c DONE (operator UNKNOWN reconciliation, real hard kill, migration hygiene + typed downgrade refusal) — hark-restart 40218221060 @4f31563 |
| 9 | Installer upgrade / downgrade / data-retention policy | H13 | DONE (self-review) on CI: hark-upgrade 40218221052 @4f31563 (upgrade, downgrade refusal, uninstall retention, reinstall); zh-CN wizard |
| 10 | Controlled real tools / DSH runtime, actual file Artifact/CAS/Validation/Handoff on a real goal | H15 | DONE (Hark self-review; approved 2026-10-26): H15a packaged pinned kernel + health + PONG; H15b native.job wiring + real file artifact smoke; H15c real DeepSeek goal PASSED hark-live-goal 40305126182 @b97bdee (EXECUTED_ARTIFACT_CAS_VALIDATION_HANDOFF, 15 calls all KNOWN, ledger ¥0.468/¥1); realistic CNY 5 acceptance run NEXT; independent review pending |
| 11 | Windows file/network isolation (beyond Job Object) | H16 | DONE (Hark self-review; approved 2026-10-26; Windows CI runners only, never the user's PC): H16a probe PASS hark-isolation 40334964921, H16b-2 lifecycle PASS 43/43 hark-isolation 40352982060, H16b-3a seam installer 40360476317, H16b-3b installed isolated PONG 13/13 + install smoke 36/36 hark-installer 41199673358 @b6c85cc (windows 41199673369, ubuntu 41199673359, isolation 41199673425, restart 41201181182). Residuals (DNS via DNS Client, other volume roots readable, needs one UAC) in H16_WINDOWS_ISOLATION.md; independent review pending |
| 12 | Ordinary-user desktop acceptance, same-device comparison with Codex lane | H17 | APPROVED 2026-10-26: checklist H17_REAL_PC_ACCEPTANCE_CHECKLIST.md + packet H17_INDEPENDENT_REVIEW_PACKET.md drafted 2026-10-27 (user / reviewer execute, never self-granted). H17a first-run setup DONE (self-review): H17A_FIRST_RUN_SETUP.md (Start menu CompanyOS 首次配置, DPAPI key, main-process overlay, user budget approval); installer smoke h17a-* 8/8 hark-installer 41199673358 @b6c85cc. Real-PC acceptance + independent review: NOT RUN (user / reviewer execute) |
| 13 | Ubuntu gate where applicable | H14 | DONE (self-review) on CI: hark-ubuntu 40227470496 @243eded (vitest 3806/3809, 0 unexpected, 3 env-bound baselined with reasons) |
| 14 | tag / release | H18 | APPROVED 2026-10-26 (unsigned; code signing declined); procedure H18_RELEASE.md — tag only a commit with every workflow green, assets from that commit's own hark-installer run |

Rules carried by every stage: keep first failures, never add counts across runs,
NOT RUN/UNKNOWN/BLOCKED never become PASS, self-review is never independent review.
