# Live contract-fill goal — result

Real DeepSeek goal run through the installed CompanyOS (hark-live-goal workflow, Windows runner):
"开发一个跨平台的合同自动填写软件，支持手机和电脑端……确保合同格式和原有排版保持不变".

## Final run

- Run 18: hark-live-goal 42756324973 on 135c3a8 (resume of run 17, 42730130436), 2026-11-10 12:44–14:05 CST.
- Result `GOAL_COMPLETED_CLEAN`, monitor `TERMINAL_COMPLETED`; goal run COMPLETED; 6 plan steps + 1 corrective
  task DONE; run validation failed once (repo.test-check deadline on a LibreOffice-backed suite), one
  corrective round with the validator's failure detail (run-17 fix) turned both validators green,
  then review passed and the run was delivered.
- Spend CNY 1.495868 (213 calls, all KNOWN). All 18 contract-fill runs: CNY 42.001
  (`installer/budget/live-contract-fill-ledger.json`).

## Generated application (Hark self-review)

| Requirement | Status |
|---|---|
| Import Word template, detect fillable fields | Yes — purchase (7 fields), equipment, technical-service (6 fields) templates |
| Manual and paste input, auto match + fill | Yes |
| Preview and edit | Yes (contenteditable preview flows into export) |
| Export Word or PDF | Yes — DOCX; PDF via LibreOffice headless, 503 `PDF_TOOL_MISSING` + Word fallback when absent |
| Layout preserved | Yes per tests (styles/numbering byte-equal, skeleton equal, A4, tables) |
| Phone and desktop | Responsive web UI served by a Node HTTP server (390 px / 1440 px flows tested) |
| Own tests | `node test/all.test.js` 89/89; independent step-6 verification 3/3 |

Limits: PDF needs LibreOffice on the machine; phones use a browser against the PC server, not a native app.

## Defects fixed in CompanyOS along the way

Runs 6–17 each exposed CompanyOS defects that were fixed at the root with regression tests:
[run 6](./LIVE_CONTRACT_FILL_RUN6_FIXES.md) · [run 7](./LIVE_CONTRACT_FILL_RUN7_FIXES.md) ·
[run 8](./LIVE_CONTRACT_FILL_RUN8_FIXES.md) · [run 9](./LIVE_CONTRACT_FILL_RUN9_FIXES.md) ·
[run 10](./LIVE_CONTRACT_FILL_RUN10_FIXES.md) · [run 11](./LIVE_CONTRACT_FILL_RUN11_FIXES.md) ·
[run 12](./LIVE_CONTRACT_FILL_RUN12_FIXES.md) · [run 13](./LIVE_CONTRACT_FILL_RUN13_FIXES.md) ·
[run 14](./LIVE_CONTRACT_FILL_RUN14_FIXES.md) · [run 15](./LIVE_CONTRACT_FILL_RUN15_FIXES.md) ·
[run 16](./LIVE_CONTRACT_FILL_RUN16_FIXES.md) · [run 17](./LIVE_CONTRACT_FILL_RUN17_FIXES.md).

Open polish candidate: the right-panel validation counters show 0 for a resumed run's validations.

Status: Hark self-review only; real-PC acceptance and independent review NOT RUN.
