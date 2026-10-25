## 2026-10-25 Hark lane H10b — plan-only preview: real DeepSeek planning turn (run 40162770951, ¥0.00574) produced a 1-item plan; execution refused with EXECUTOR_PROVIDER_UNKNOWN. See docs/hark-lane/H10_TRUSTED_BUDGET.md.

## Hark lane — 2026-10-25 H8 per-user Windows installer (CI)
- Added stage-desktop.mjs, installer/companyos.iss (Inno Setup, per-user), installer-smoke.ps1, workflow hark-installer.yml. No new npm deps.
- First run 40112120130 rejected (missing persistence migrations → DB bootstrap failed; smoke didn't read log levels). Fixed d5ee0dd.
- Run 40112501131: install/launch/uninstall 15/15 checks, DB ready, window shown. Installer sha256 2592AC21…E9A8.
- Hark self-review PASS (H8 scope). Not signed, not tested on a real user PC, no release/tag, Independent Review not granted. See docs/hark-lane/H8_WINDOWS_INSTALLER.md.

## 2026-10-25 Hark lane — H7 stdout/stderr capture
- Commit 1a7219b. CI 40110944441: offline 117/117, native 25/25 (green on the first push). Pipes + HANDLE_LIST, bounded, EOF after drain; the contract gains structured-output only when capture is on.
- Hark self-review PASS (H7 scope). Independent review NOT granted. Doc: docs/hark-lane/H7_OUTPUT_CAPTURE.md

## 2026-10-25 Hark lane — H6 Supervisor integration contract
- Commit bc81549. CI 40110364994: offline 107/107, native 21/21. Not production-wired (guard test). One surviving mutant found and fixed (provider own latch).
- Hark self-review PASS (H6 scope). Independent review NOT granted. Doc: docs/hark-lane/H6_SUPERVISOR_CONTRACT.md

## 2026-10-25 Hark lane — H5 handle-pinned launch (TOCTOU)
- Commits 88080fb, 7a87828. CI 40109482553: offline 87/87, native 19/19 (first run 40109275557 16/18 kept: test bug).
- Pinning REQUIRED by default; exe/inputs/dir chain share-mode pinned; re-hash through handle; reparse/redirect/multi-link refused; image path checked before resume.
- Hark self-review PASS (H5 scope). Independent review NOT granted. Doc: docs/hark-lane/H5_HANDLE_PINNED_LAUNCH.md
- Next: Supervisor integration contract.

## Hark lane — H4 native lifetime completion (2026-10-24)
- Commits 4f8ab1b, 9950b33. CI run 40107704862: offline 76/76, native 14/14, all steps success (first failures kept: local 63/65, 72/73; CI 40107390262 13/14).
- Native proof added: binding failure (1816) never resumes; owner crash with/without watchdog; owner hang -> watchdog OWNER_UNRESPONSIVE; release path; cancel race fixed.
- Hark self-review H4 PASS; independent review still required. Next: H5 handle-pinned launch (TOCTOU). Doc: docs/hark-lane/H4_NATIVE_LIFETIME.md.

## Hark lane H2（2026-10-24 HKT，候选，待独立审查）
- 依赖已在本线安装（frozen lockfile、ignore-scripts）。typecheck exit 0、全仓 lint exit 0、Hark 离线 65/65、门禁 exit 0。
- vitest 全量：Hark 42/3741 失败，基线 39/3741 失败；差异经双方定向复跑确认为本机流捕获时序漂移，非 Hark 回归。详见 docs/hark-lane/H2_DEPS_REGRESSION.md。
- 新增 `.github/workflows/hark-windows.yml`（手动触发，未运行）。Windows native、Electron、安装包仍 NOT RUN。

# CompanyOS — PROJECT HANDOFF

> 单一事实来源：**本文件描述“现在到底是什么状态”**（AGENTS.md §0.1）。
> 设计见 `docs/`，纪律见 `AGENTS.md`，执行路线见 `docs/EXECUTION_ROADMAP.md`。
> 最近更新：**2026-10-13 Sprint 2 documentation state sync**（仅当前状态同步，非新功能或候选冻结）。


## 2026-10-24 Hark lane H3 — Windows CI + native Job Object (CI only)
- Windows CI runs on every push to the hark-lane branch (dispatch never registered). Run 40106440529 @59f0248 passed every step: offline 65/65, gates 0, koffi@3.3.3 integrity pinned, **native Job Object 7/7** on windows-2022 x64.
- New: `apps/desktop/src/executor/native-lifetime/koffi-job-port.ts` (koffi injected, not a dependency, not wired to production) and `tests/hark-native-lifetime/native/*.win-test.ts`, run by `scripts/hark/test-hark-native.mjs` under `register-native.mjs`.
- Failed runs are preserved, along with review findings (conhost member; TerminateProcess code 5 during cancel). See docs/hark-lane/H3_WINDOWS_CI_NATIVE.md.
- NOT proven: native watchdog/lease transport, TOCTOU handle-pinned launch, Supervisor wiring, Electron, installer. Independent review is PENDING.

## 2026-10-24 — Hark lane: Phase 3B-3E offline (H1, review pending)

- Lane root = SOURCE import, tree `c2973b1acc5099325a644a51d27814e44d9fcd28` (checkpoint `7c86f2a681cc4d348c0238a4b6119931c74e423f`); new root commit, not ancestry. Sole Writer: Hark. No source/frozen/E/Codex writes.
- New offline lifetime layer under `apps/desktop/src/executor/native-lifetime/` (port, launch pins, Job lifetime adapter, independent owner-hang watchdog contract). Not wired to production; not a sandbox; no permission factory.
- Final offline run: 65 tests / 65 PASS / 0 FAIL, exit 0 (simulated Win32 kernel). Three earlier failing runs (test-side bugs) preserved. Native Windows: NOT RUN. koffi: BLOCKED (not installed). Typecheck/Lint/Vitest: NOT RUN (no deps).
- Details: `docs/hark-lane/TAKEOVER_REPORT.md`, `docs/hark-lane/3B3E_OFFLINE_RESULT.md`. Next: independent review; authorization requests for dependency install and a Windows x64 test host.

## 2026-10-24 — Phase 3B-3B trusted budget proof contract (implementation; review pending)

- Boss accepted Phase 3B-1 and Phase 3B-2 independent review. Their Local Draft/real desktop persistence and deterministic exact-file delivery scopes remain accepted; earlier implementation-stage review-pending/NOT RUN entries below remain historical. No real AI acceptance is implied.
- Phase 3B-3 and 3B-3A safety/contract STOP reports remain sealed. This new authorization completes only the desktop outer proof contract. Existing reservation.bound.evidenceRef already persists in canonical SQLite; it now pins the complete immutable identity/price/token proof by its existing CAS sha256 reference. No Schema, Core/Engine, ExecutionAttempt or budget-arbitration change.
- Explicit trusted deployment ports must resolve actual canonical execution/provider configuration and externally attested upstream/billing identity, approved exact proof hashes and existing CAS bytes. There is no renderer/env/self-verified JSON import, proof creator or new proof/budget database. Production rejects TEST_ONLY sources; real proofs, trust evidence, retention and fees remain external prerequisites.
- Agent admission reads canonical AgentExecution Provider/Model binding; Executor admission checks its selected endpoint/credential pointer. Identity includes upstream/routing/billing/account/organization/attestation. Price source/version, units/currency, token bounds and validity are verified. Opt-in policyId hashes trust scope/currency/billing scope into the existing persisted policy identity so updates cannot mix accounts/units; legacy policy IDs/behavior remain unchanged.
- Settlement re-reads the canonical reservation and original CAS proof, never select/latest-price or a process-local pin map. Price updates leave older references unchanged. Missing/revoked/corrupt original proof or missing/invalid usage stays UNKNOWN; recovery keeps original refs but still changes RESERVED to UNKNOWN, never refunds/replays/refines it. Duplicate/late/cancelled settlement retains canonical arbitration.
- Final safe targeted: 9 files / 152 PASS / 0 FAIL / 0 SKIP (42 new proof contracts + original 110); Node and wrapper exit 0, no unhandled error reported. Scoped Lint and Typecheck exit 0. Initial 34-case proof run and intermediate 150-case run are retained, not added to final counts. Real local SQLite/CAS close/reopen proves original references survive selector/price updates; TEST ONLY approvals/selectors are local fixture files, not a production verification service.
- Only attested linear integer-micro rates per million input/output tokens with ceiling on total per-request charge are supported; no guessed cache discounts, extra fees, FX, default prices or unqualified totalCost substitution. Exact arithmetic uses BigInt. Unsupported real billing remains blocked.
- Production limits remain 4 calls / 32768 tokens / maxCostMicros=0 / 180000ms. No source is installed or implicit Provider activated. REAL_PROVIDER_ADMISSION NOT APPROVED; REAL_DSH_SANDBOX NOT ACCEPTED; missing complete DSH runtime, real model/price/account/token proofs, Medium user, real stop/recovery, installer and release remain blocked.
- ADR-0033 records rationale/alternatives/frozenAreas/revisitWhen. Evidence and exact patch: Phase3B3B-Trusted-Budget-20261024 under the approved Codex evidence root. Frozen/E source, Guard, DSH approval and prior 3B-1/3B-2 implementation bytes remain protected. No full gate, dependency install, DSH/real Provider, ACL/MIC/Owner operation, Git staging/commit/push/tag or release.
- E-root DACL OPEN; C-user SDDL NOT VERIFIED; Historical TCP/RC5/CROSS-TASK UNKNOWN. Stop for independent delta review and Boss adjudication; no automatic real execution.

## 2026-10-24 — Phase 3B-2 exact file delivery (offline implementation; review pending)

- Phase 3B-1 source review and real Electron local draft save/restart are Boss-accepted A/PASS (9/9 managed exits 0; unauthorized Goal/Run/Task/dispatch 0). Its six-file evidence and the older implementation-stage NOT RUN entry below remain unchanged as history. Local Draft storage/controls and recovery logic are unchanged this round.
- Reused canonical structured.fileDeliveries, Plan criterion coverage, WorkPackage, executor file carrier, Artifact/CAS, blocking Validators and runtime successor Handoff. Added optional relative path + exact UTF-8 content fields to the existing explicit Submit path; the existing outbox persists the same contract across pending-intent replay. File requirements are explicitly NOT part of the previously accepted objective-only local draft. Save Draft remains non-executing.
- Existing single terminal Task has no successor and therefore no inter-task Handoff by design. The new deterministic E2E uses the existing compiler for produce -> inspect, not a new DAG/scheduler. The local executor really writes hello.txt; canonical file validation reads exact bytes, CAS preserves ownership, READY Handoff references actual Artifact plus PASS evidence, and Goal plus execution Run reach COMPLETED. No canonical schema/state machine/ExecutionAttempt/budget/Guard/provider production changes.
- Final broader targeted run: 8 files / 109 PASS / 0 FAIL / 0 SKIP, including original 75 Local Draft/client/budget/recovery cases, 11 cancellation, 18 verified-file, and 5 new tests. After equivalent scoped Lint fixes, the 5 changed tests were rechecked PASS, plus Lint and Typecheck exit 0. The 109-test Node entry exited 0; Python console printing later exited 1 due to GBK encoding after raw stdout/stderr/metadata were safely saved. The subsequent changed-test wrapper exited 0. Do not conflate wrapper printing failure with a Vitest failure.
- Negative evidence covers executed-but-wrong/missing files (anti-vacuity execution count), traversal/absolute paths, junction/hardlink/identity/validator rejection, duplicate settlement, UNKNOWN fail-closed, deadline/cancellation and draft isolation. Initial E2E failure was the deterministic fixture not advertising executor call admission; only the explicit test-only callback fixture now supplies matching mock route/proof. This is not production price/token evidence. First failures and scoped Lint failures are retained.
- Final verified source adds a real React submit-lock regression: a queued duplicate does not create a second intent while hashing, and acknowledgement releases the lock for the next explicit submission. Final 8 files / 110 PASS / 0 FAIL / 0 SKIP; Node and evidence wrapper exit 0; Scoped Lint and Typecheck exit 0. This supersedes the earlier 109-test intermediate run for the final code identity; counts are not added across runs. Existing App LF style is preserved.
- No Electron acceptance, real AI/DSH, full six-stage gate, ACL/system change, dependency install, Git staging/commit/push/tag or release. Real pricing/token proofs, DSH sandbox/process stopping, real cancellation/file protocol, Medium user, Ubuntu and Packaging remain unaccepted; E-root DACL OPEN, C-user SDDL NOT VERIFIED, historical TCP/RC5/CROSS-TASK UNKNOWN.
- Evidence: Phase3B2-FileDelivery-20261024 under the approved Codex evidence root; PHASE-3B2-FILE-DELIVERY-RESULT.md and REVIEW.patch identify this delta. Frozen acceptance source, E and historical evidence are protected. Stop here for independent review and Boss adjudication; no automatic Phase 3B-3.

## 2026-10-24 — Phase 3B Local Unsubmitted Draft implemented (independent review pending)

- Boss chose Option 1, LOCAL_DRAFT: only local UI editing data, never canonical Goal/Run/Task truth. The canonical persistent draft option remains unimplemented; the 2026-10-23 contract STOP below is preserved as history.
- Added Renderer local draft storage/controls, scoped by company + exact canonical Workspace path, inside Electron default-session localStorage/userData. Save/restore cannot invoke a bridge or create an outbox. Missing/failed/corrupt storage is reported; known credential assignments and oversized input are refused. No model configuration or credentials are serialized.
- UI offers 保存草稿 / 恢复草稿 independently of model readiness. 提交并开始执行 alone retains the existing submission controller and canonical goal.create path. Workspace changes clear previous editor contents before loading the target draft. Saved drafts are distinct from previously submitted pending intents, whose replay/recovery behavior is unchanged.
- Targeted final: 4 files / 75 PASS / 0 FAIL / 0 SKIP (13 local draft + 29 existing client intent + 26 durable budget + 7 desktop recovery); Node wrapper exit 0, no unhandled error reported. First attempt 74 PASS / 1 FAIL retained; missing platformInfo in the new fake bridge corrected without changing product behavior or assertions.
- Scoped Lint and project Typecheck final exit 0. No full gate/build, real AI/DSH/Goal, Electron desktop restart, permission change or dependency installation/download. Dependencies were independently copied and internal links remapped inside this development copy. Reviewed preparation generated only three pinned offline test resources; no real Kernel was copied or started.
- Persistence evidence is storage re-instantiation plus real React/App save and React remount tests; actual Electron close/relaunch acceptance remains NOT RUN. The current result does not close Phase 3B or real execution readiness.
- Remaining: trusted pricing/token proofs, Windows DSH sandbox/process stopping, full file delivery/Handoff, real Provider/Goal, Medium user and Packaging. E-root DACL OPEN; C-user SDDL NOT VERIFIED; historical TCP/RC5/CROSS-TASK UNKNOWN.
- Evidence and review patch: Phase3B-Local-Draft-20261024 in the approved Codex evidence root. Frozen acceptance source and E formal repository unchanged. No Git staging/commit/tag/push or release. Await independent review and Boss adjudication.

## 2026-10-23 — Phase 3B blocker closure: isolated copy, contract STOP

- Boss authorized an independent development copy at F:/CompanyOS-V1-Phase3B/repo; 914 source files and independent Git metadata were copied from frozen commit d5d41a0048ffff5b6ddf4a9b1f69af5a7e900b9d / tree e2cc9d2d0725a3f3c06fcce1968a26fe235c89ba. No shared file IDs/hardlinks, copied dependencies, databases, Profile or materialized Kernel. Frozen source and E remain protected.
- Implementation stopped BEFORE product changes at the explicit database/state-contract boundary. Canonical RunGoal is an immutable run-owned Artifact, not an independently editable draft. Main starts goal.create immediately; boot recovery also starts every nonterminal Goal Run. Removing only the immediate start cannot make saved Goals non-executable across restart.
- A durable canonical draft/explicit-activation feature requires defining an authorized persisted activation fact and atomic promotion/recovery semantics. No schema, state-machine, budget, recovery or security changes have been made. Existing WORKFLOW_REVIEW draft concerns Workflow design, not a Goal draft. UI-only localStorage could store an unsubmitted text definition, but cannot be reported as canonical Goal persistence or authorization.
- Boss decision needed: either explicitly scope the feature as a local unsubmitted definition (no Goal/Run identity until Execute), or authorize a reviewed canonical durable draft/activation contract using the existing authority. This is not an implementation approval for either option.
- Existing structured.fileDeliveries / Validation / Handoff are reusable; no duplicate verifier/orchestrator added. Budget still refuses unproven token/price bounds. No DSH preparation script, Kernel, Provider, Goal or Electron was run; no ACL/MIC/Owner actions.
- Actual test runs: 0 (NOT RUN after mandatory contract STOP); no new PASS claim. No full gate rerun, Git staging/commit/tag/push, E write or release.
- Full new execution record and exact source excerpts: Phase3B-Blocker-Closure-20261023/PHASE-3B-BLOCKER-CLOSURE-REPORT.md and contract-boundary-evidence.json under the authorized Codex evidence root. This entry changes only this isolated copy and does not rewrite the frozen handoff.

## 2026-10-13 — Windows-first gate convergence（当前，F 本地候选）

- Boss 批准 Windows V1 Release Gate PRIMARY、Ubuntu Compatibility INDEPENDENT；共享安全/正确性 P0/P1 阻断两门。详见 `docs/WINDOWS_V1_RELEASE_GATES.md`。
- Ubuntu CI 保留完整检查、原 job/status name、Node 22/24、pnpm 11.25.0，仅明确 pin ubuntu-24.04；远端必需检查/分支保护未修改，不能绕过其失败合并。
- 已审查的 F 本地候选包含 11,697 字节 MIT 只读 Kernel 哈希拒绝夹具及两项固定文本重建入口；本轮仅同步两份文档，不执行 Kernel/PowerShell/Provider/Goal，不继续自建 Ubuntu VM。
- `WINDOWS_FIRST_FULL_OFFLINE_QUALITY_GATE = PASS`（Date: 2026-10-13；Boss 已裁定 CLOSED）。6/6 stages PASS；299 test files；3682 PASS / 0 FAIL / 0 SKIP；No reported unhandled error；Build 3/3 PASS；Node / Wrapper exit 0 / 0；一次执行，267.91 秒；Evidence 98 items。
- 验收来源：[最终完整门禁报告](F:/chatgpt/CodexData/visualizations/2026/10/05/01a10e6b-7a2f-7e02-b394-4e6e12e57701/Windows-First-Final-Gate-20261013-0913/WINDOWS-FIRST-FINAL-FULL-GATE-RESULT.md)，SHA-256 `DFB691BBD581BBA88DD141E5031D4A5E2686A23C729E25026614D5932524C919`；[98 项证据封存清单](F:/chatgpt/CodexData/visualizations/2026/10/05/01a10e6b-7a2f-7e02-b394-4e6e12e57701/Windows-First-Final-Gate-20261013-0913/evidence-sha256.json)，SHA-256 `4AA1EF3147537C9346EA11CC69F0DE1DF889D21384E3531FA6DCDFD5BF1FB416`。门禁覆盖同步前经核验的 914 项候选；本次唯一新增内容差异为两文档状态同步，不把文档同步称为新门禁执行。
- `SPRINT2_CANDIDATE_FREEZE = BLOCKED / NOT YET AUTHORIZED`。冻结前审计提出 138 文件实现范围（74 项修改、64 项新增）；该清单不是已暂存或已提交范围。PROJECT_HANDOFF.md 单独处理；本次文档同步仍需 ZCode 增量审查，不构成正式冻结。
- `WINDOWS_V1_RELEASE = BLOCKED`。Real DSH / Provider / Goal、Medium Integrity User、完整 Electron Desktop 交付、Persistence / Recovery、Windows Packaging / Installation / Uninstallation 和 Shared Correctness and Security Blockers 仍须各自独立验收；既有启动/Workspace 等部分验收不等于完整发布验收。
- `UBUNTU_COMPATIBILITY = NOT ACCEPTED`；原生 Ubuntu 验证 NOT RUN。Ubuntu 完整 CI 检查及远端必需状态不变，NOT RUN / FAIL 不改为 PASS；按已批准契约独立管理 Windows 候选冻结与 Ubuntu 兼容性。
- E-ROOT-DACL-CHANGE OPEN；C-user SDDL NOT VERIFIED；Historical TCP / RC5 / CROSS-TASK UNKNOWN；真实业务、Medium 用户和打包 NOT ACCEPTED。
- 下方较早报告保留为历史，不覆盖本节当前状态。未暂存、提交、同步 E、上传或发布。

## Execution safety Sprint 2 — 2026-10-11（F 候选，独立审查待安排）

- Boss 已批准 ADR-A / ADR-B / ADR-C。M1 在既有 SQLite Run 上增加 Goal 预算 envelope，逐次外部调用预留、结算、持久截止时间与 UNKNOWN 恢复；无第二数据库或调度器。
- M2 先持久化取消意图再中止本地传输；迟到 Agent/Executor 结果经既有终态仲裁拒绝，重启不恢复已取消的新执行。取消受理不证明远端或进程已停止。
- M3 将实际文件、规范化 Workspace 身份、大小/哈希和 Goal/Run/Task 归属核验后交既有 Artifact/CAS/Validation；所有 pinned Validators 保持 additive/blocking，Handoff 只引用已验证业务文件及 PASS。READY 与最终取消检查处于同一 canonical 事务。
- 新 additive migration `engine/0008_goal_execution_budget.sql`：旧行 NULL 拒绝外部派发，旧身份和状态枚举不变。旧库升级、重放/校验和拒绝、停机备份恢复均有离线回归；不得通过回滚抹去可能已发生的远程费用。
- 最终安全 targeted 15 files / 131 tests PASS；lint / typecheck / boundaries / architecture / build PASS，原始 `pnpm test:scripts` 25/25 PASS。三项离线缺陷回注分别引发 deadline / cancel / file-owner 回归失败，恢复后字节哈希一致。所有首跑失败日志保留，不删除/跳过原断言。
- 原始 `pnpm check` 首跑在 typecheck 失败；第二跑 294 files / 3648 tests，3642 PASS / 6 FAIL，build 未执行。五项迁移/取消命令旧契约失败已定向修正并验证；`security-agent-attack` CROSS-TASK 第二次退出码 1（预期 0）原因 UNKNOWN，未重跑。Full Quality Gate = BLOCKED，单项 PASS 不等于原始完整门禁 PASS。
- 执行范围事件：预检错误地认为隔离环境变量会替代 Kernel；默认安全测试实际启动了 Embedded DSH Kernel。这是未获本轮授权的执行，不是 live acceptance PASS。该跑已结束，随后新增仅允许显式离线文件的诊断命令入口及 Kernel 路径拦截，不再运行默认套件。原始进程/网络/ACL 观察并不完整，相关副作用不能宣称不存在。
- 生产未取得可信 tariff / upstream token bounds，默认严格拒绝外部执行；FINANCIAL_HARD_CAP_NOT_PROVEN。真实 Provider、DSH 文件交付协议与取消/停止、Windows ACL 沙箱及并发 reparse 原子隔离仍 NOT VERIFIED / BLOCKED，不构成 live execution 授权。原网络 retry 单元保留原断言，新增 production UNKNOWN 阻止重试回归。
- E/F HEAD 不变，E 不写入、不提交；历史证据保留。ADR 及迁移/回滚说明见 `docs/adr/0032-goal-execution-safety.md`；完整证据见 `F:\CompanyOS-Diagnostics\Desktop-Phase3B-B\execution-safety-sprint2-20261011-01`。
- 仅提交实现供 Boss 和 ZCode 独立审查，不自授 CLOSED，不进入下一阶段、不打 V1 Tag。

## Execution safety closure — 2026-10-11（历史：ADR 批准前仅局部修复，BLOCKED）

- 基线 E/F HEAD 均为 `45b68682e67ce07724d33eefffdd2d8e304ded7f`；E 仓库、285 个历史 tmp-e2e 文件、既有 userData 和 DSH 资源保留。无提交、真实 Provider/Goal/DSH Kernel 或 Electron 启动。
- 已修复局部缺陷：Broker 在读取 body 前占用并发额度，单次结算且 body 等待有界；模型 missing/invalid usage 非重试失败且保持 UNKNOWN；usage 投影读取实际 output_usage 输入量，不把失败/运行中占位值视为已知零。
- 本地 ProcessExecutor 在 spawn 前后检查取消；缺少 timer 拒绝带 deadline/signal 的请求；树停止结果与根进程退出共同构成停止证据；5 秒清理上限，失败仍不证明停止，迟到输出不能改写返回结果。仅测试隔离 Node 子进程，不启动真实 DSH，不修改 ACL。
- DSH Adapter 拒绝缺少 final 或空 final 的 exit-zero 输出，保留既有诊断 Artifact 接线。诊断摘要不等于业务文件已验证，真实 DSH E2E 仍 NOT VERIFIED。
- 必须由 Boss 裁定：现有 durable budget 是非法提案计数，未提供全 Goal 预留/结算/截止时间契约；Run.cancel 排在执行 await 后，缺少即时 durable Goal 终止意图；业务文件载体与验证后 Handoff 的契约仍待明确。未新增账本、状态机、迁移或全局调度器。
- 详细首跑失败、最终针对性回归、代码差异、哈希及待裁定方案见 `F:\CompanyOS-Diagnostics\Desktop-Phase3B-B\execution-safety-closure-20261011-01\EXECUTION-SAFETY-CLOSURE-IMPLEMENTATION-REPORT.md`。仅局部补丁待独立审查；不得宣布安全闭合或真实执行可获批准。
- 三个 Milestone 尚有 P1，按本轮授权不运行完整 pnpm check / pnpm test:scripts。FINANCIAL_HARD_CAP_NOT_PROVEN；ZCode 独立验收待安排；不自动进入下一阶段、不打 V1 Tag。

## R4 targeted fixes — 2026-10-11（仅 F 盘候选，待独立审查）

- Boss 仅授权 R4-F1 / R4-F2 Renderer 契约修复；原 E 盘仓库和历史诊断保持不变，无提交、合并或 Electron 启动。
- R4-F1：读取 tools.list 的 items，沿显式 nextCursor 读取完整列表；拒绝错误分页和畸形响应，错误不再显示假空态。
- R4-F2：通过现有 home.summary 的服务端 Company 校验取得 companyId；memory.retrieve 显式传入 Company scope 和 now，投影真实检索结果 items。
- 页面查询仅为 canonical 只读投影；切换页面、卸载后丢弃迟到结果，没有新增身份权威或修改 Runtime。
- 新增真实 React 挂载及契约回归 32 项；最终 Renderer 10 files / 179 tests PASS，包含原 DRA-05 20 项回归。
- 完整门禁、首跑与最终结果以 `F:\CompanyOS-Diagnostics\R4-Targeted-Fix\fix-20261011` 的日志和报告为准。
- 修复尚未独立验收；真实 Electron 视觉复验 NOT VERIFIED，Visible Desktop 仍 BLOCKED，不进入 Phase 3B-B、不打 V1 Tag。

## V1 bounded repair takeover — 2026-10-10

- Boss 授权 Codex 为唯一主执行端，ZCode PAUSED / STANDBY；仅修复 DRA-05 P1/P2 与质量门禁。
- 接管基线：main / `d60fd218696e69966244ba6555527bc68d008c1a`，无已跟踪差异。
- 历史 `tmp-e2e/` 285 个实体文件（256 未追踪、29 忽略）与独立审计清单逐一 SHA-256 相符，全部保留。
- TASK 1：Goal 切换清空旧投影；任务读取前与提交后绑定 Goal / execution Run / Task / Stage，处理拒绝与卸载。
  原始 P1 React 挂载复现修复前 FAIL、修复后 PASS；Renderer 9 files / 139 tests PASS，typecheck PASS。
- TASK 2：每个 Runtime IPC 本地等待上限 15 秒；底层无取消接口，物理请求直到真正 settle 才释放额度。
  整个 App 最多两个未结束 Runtime 读取（含旧 Goal / 超时读取），额度耗尽后显示阻塞，不再增加 IPC；
  实际返回后由已有 4 秒轮询恢复。Goal 切换与卸载清理本地等待，迟到结果丢弃；完整投影提交后才停止终态轮询。
  React 挂载 20 tests PASS，Renderer 9 files / 147 tests PASS，typecheck PASS。
- TASK 3A：原始 pnpm check 首跑在 lint 的两个历史入口报 16 errors。仅排除
  `tmp-e2e/minimal-app/main.js` / `tmp-e2e/probe/main.js`，保留原始文件；pnpm lint PASS。
  两项脚本回归确认范围精确、其他路径仍执行 undefined-global / CommonJS import / Core 边界规则。
- TASK 3B：旧 CROSS-TASK 断言将共享 `.dsh-homes` 数量误当作单调不变量，而 Provider finally 正常删除自身 home，
  resolver 还会回收无活跃 owner 的 home。独立临时目录的三个真实生命周期测试证实 1→0、不同 home 身份及独立清理。
  原失败用例单独运行 PASS，历史全量失败中的具体目录及清理进程 UNKNOWN，未冒充观测到并发清理。
  修复仅限测试：唯一的临时 lab 根；观察真实 newDshHome 分配，不替换任何安全/启动/清理实现，
  检查两次路径互异、创建时存在、结束时释放，保留 hostile kernel 测试。相关 2 files / 20 tests PASS。
- 全量原始 pnpm check：首跑 Exit Code 1（lint 16 errors），修复后 Exit Code 0，6/6 门禁 PASS；
  正式本地全量 `vitest run --exclude tests/provider/**`：284 files / 3522 tests PASS，无新增 skip/only。
  pnpm test:scripts 25/25 PASS。DRA-04 保持 CLOSED，
  打包 resources / managedRoot 写入 / readiness 原因传播风险未关闭。
- 证据：`F:\CompanyOS-Diagnostics\Codex-Takeover\sprint1-20261010-141636-fbb0c1ff`（保留首跑日志）。
- 实现必须交其他 Independent Reviewer 验收；不自授独立审查 PASS。Canonical Runtime Correctness Gate CLOSED，
  Visible Desktop BLOCKED，Windows Packaging 未验收，NO V1 TAG；禁止 Electron 可见启动、Windows 安全权限修改与 push。
- 下方 Sprint 16 内容为历史交接记录，不覆盖本次 Boss 的有限修复授权。
- 待独立复核：DRA-05 请求归属与永久 Pending 降级。底层 IPC 无取消接口，两条物理读取均永久 Pending 时
  维持可见阻塞，不会承诺一定恢复；只有实际 settle 释放额度后恢复读取。该额度只针对 Runtime 投影读取，非所有 Bridge 操作。

## Current State（当前状态）

- **阶段**：Sprint 0–16 已关闭；Sprint 10A / 10B / 10B.1 / 10B.2 与 Router 主线均为 **CLOSED**，
  Sprint 11 Structured Handoff 亦为 **CLOSED**；Sprint 12 Memory + Decision 也已 **CLOSED**；
  Sprint 13 Artifact + Validation（tag `sprint-13.0.0`）、Sprint 14 Recovery（tag `sprint-14.0.0`，
  收口 `docs/SPRINT14_CLOSEOUT.md`）、Sprint 15 Industry Pack Framework（tag `sprint-15.0.0`，
  收口 `docs/SPRINT15_CLOSEOUT.md`）与 **Sprint 16 DevCompany Pack**（tag `sprint-16`，
  收口 `docs/SPRINT16_CLOSEOUT.md`）均已完成最终收口。
- **Git 核验基线**：branch `main`；Sprint 13 收口前 HEAD `0d79b54`（read-authority reconciliation）；
  收口 commit 与 tag 段见本文 Commit 节与 `docs/SPRINT13_CLOSEOUT.md`。**不得移动 `sprint-12.0.0`。**
- **关闭门槛**：Sprint 11/12/13/14/15/16 Independent Review（Boss 逐 Task review）均无未决 BLOCKER/HIGH；
  下一阶段为 Sprint 17（Repository Runtime，pending），未经批准不得开工。
- **Tag 惯例说明（Sprint 16）**：历史 tag 采用 `sprint-N.0.0` 形式；Sprint 16 按 roadmap 权威
  `Git Checkpoint: sprint-16` + Boss 明确裁定创建 annotated tag **`sprint-16`**（不替换为
  `sprint-16.0.0`）。后续 Sprint 若无同类明确裁定，沿用 `sprint-N.0.0`。
- **已交付能力**（Sprint 13 已收口，完整清单见 `docs/SPRINT13_CLOSEOUT.md`）：
  - durable Artifact（不可变，SQLite + filesystem CAS 双 SoT，`contentRef=sha256:<hex>`，
    hard-link no-clobber 发布，artifactId≠contentHash≠contentRef）；
  - durable Validation（`targetRef` 绑定 ADR-0017，one command→one target→N validators，
    permanent creation identity 幂等）；
  - Validator 受控解析/执行（复用 Sprint 9 Tool Registry capability 门）、durable tool replay
    output（ADR-0018）与 version provenance（ADR-0019，legacy null 永不回填/不可执行）；
  - evidence-backed `VALIDATION.PASS`（ADR-0020：run-pinned stage validatorIds = blocking-required，
    latest durable batch wins）；
  - Memory ARTIFACT/VALIDATION provenance（identity-only）；Agent/Tool/Handoff/Decision 写入面
    durable 引用强制（resolve-all-before-write）；
  - production composition：`userData/artifacts` 稳定 CAS 根 + quiescent startup reconciliation
    （fatal → fail startup closed）+ 服务全接线（单 DB/UoW/EventStore/Ledger，真实授权）；
    Sprint 13 服务为 main-process 内部能力，**无 renderer IPC operation**。
- **仍明确未开发 / 当前禁止提前实现**：Sprint 14+、DevCompany、Artifact Asset System 产品化、
  Desktop UI 接入 Artifact/Validation 视图、真实 Provider 调用及后续自动编排。Router、Handoff
  与 Sprint 13 冻结语义不得借后续 Sprint 重新设计。
- **状态分层已冻结（ADR-0003）**：L1 全局执行态 17 个（`domain/run-state.ts`）、L2 模板生命周期 4 个
  （`lifecycle/machine.ts`）、L3 Task/Stage 局部态（`domain/stage.ts`、`domain/task.ts`）。禁止混用。
- **工作区治理（ADR-0004）**：单一 Writer；Reviewer/QA 只读；并行必须用 Git Worktree。
  Sprint 1 开工前的 120 秒写入漂移采样：**140 个文件 0 变化、`git status` 空**（无第二个 Writer 活动）。

## Verified Commands（已验证命令）

以下命令为 Sprint 14 收口（T14-06）后的真实执行结果；早期基线记录保留在历史段落中。

```powershell
git status --porcelain              # 空
git branch --show-current           # main
git rev-parse HEAD                  # Sprint 14 closeout HEAD（动态核验；不硬编码）
pnpm check                          # Exit Code 0 — lint/typecheck/boundaries/test/build 5×PASS
pnpm test                           # Exit Code 0 — 116 个测试文件 / 1258 个用例全部通过
pnpm test:scripts                   # Exit Code 0 — 23/23 个 node --test 用例通过
```

Sprint 14 收口附加证据：`git diff --check` clean；Sprint 14 全部 touched 文件 UTF-8 有效、0 U+FFFD；
零迁移/零依赖/零 renderer/零 AUTHORITIES 变更审计（`git diff 641f28c..HEAD` 逐路径为空）；
空库 12 链迁移 + CAS foundation + Sprint 13 组合 + Recovery 栈构造运行成功（T14-06 §27 验证记录）。

关键证据（节选）：

- `packages/core/tests/domain/run-state.test.ts` —— 17 态齐全、终态吸收、非法转移抛
  `ILLEGAL_TRANSITION` 并列出允许事件、**规划前状态不可 PAUSE**、`RESUME`/`RECOVERED` 返回记录点；
- `packages/core/tests/domain/workflow-run.test.ts` —— 只经 L1 机器推进、返工预算（maxRework=2 时
  恰好两轮完整返工、第三次进入 REWORK 后必须 PAUSED）、快照/简历点、终态拒绝一切事件；
- `packages/core/tests/domain/role-agent.test.ts` —— Role 无 model/provider 字段；Agent 拒绝一切
  具体 provider/model（含 `logical.mistral.default` 这类未知 slot）；Core 领域源码中**不得出现厂商名**；
- `packages/core/tests/domain/artifact-validation-approval.test.ts` —— `pass` 必须有证据
  （exitCode 0 或 evidenceRefs）、**空质量门不算通过**、审批必须有 `run.approve` 授权且不得自批；
- `packages/core/tests/domain/catalog.test.ts` —— Core 词表恰为 **23** 个概念，且 PRODUCT_PLAN.md /
  AGENTS.md 不得再出现「24 个概念」；
- `docs/tests/workspace-governance.test.ts` —— 单一 Writer 规则、SoT 表、冻结优先级阶梯三处一致、
  状态三层、旧 run 词表缺席。

## Environment Facts（环境事实）

| 项 | 值 |
|---|---|
| OS | Windows（工作目录 `E:\DeepSeek.gzq\companyos`） |
| Node | v24.19.0（`node:sqlite` 免 flag） |
| pnpm | 11.25.0（`allowBuilds` 位于 `pnpm-workspace.yaml`；`package.json` 的 `pnpm` 字段已废弃） |
| TypeScript | 5.9.3（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`，ESM/NodeNext） |
| 测试运行器 | Vitest 3.2.7（Vite 6 线；Vitest 2/Vite 5 无法加载 `node:sqlite`） |
| Lint | ESLint 9 flat config + typescript-eslint 8（`.mjs`/`.cjs` 已声明 Node 全局） |
| 数据库 | 运行时 `userData/data/companyos.sqlite`（WAL）；测试用临时目录 |
| Git | 仓库级身份 `CompanyOS Agent <agent@companyos.local>`（未改全局配置） |

## Sprint 0 Deliverables（Sprint 0 交付物）

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| A1 | Monorepo（pnpm workspaces，7 个项目） | `pnpm-workspace.yaml`、根 `package.json` | ✅ |
| A2 | Electron 主进程 + 加固 preload | `apps/desktop` | ✅（运行时二进制未下载，见限制） |
| A3 | React 19 + Vite 渲染层 | `apps/renderer` | ✅ |
| A4 | TypeScript strict / ESM / 项目引用 | `tsconfig.base.json`、`tsconfig.build.json` | ✅ |
| A5 | SQLite via `node:sqlite` | `packages/persistence/src/db.ts` | ✅ |
| A6 | 迁移执行器 + `0001_init.sql` | `packages/persistence/migrations` | ✅ |
| A7 | 结构化 JSONL 日志（脱敏/关联 id/轮转） | `packages/observability` | ✅ |
| A8 | 测试 + 架构边界自检 | `packages/*/tests`、`apps/*/tests`、`scripts/tests`、`docs/tests` | ✅ |
| A9 | CI（Node 22/24 矩阵，frozen lockfile） | `.github/workflows/ci.yml` | ✅ |
| A10 | `AGENTS.md` | 仓库根 | ✅ |
| A11 | `PROJECT_HANDOFF.md` | 仓库根（本文件） | ✅ |
| A12 | 端口契约（Sprint 0 的 9 个） | `packages/core/src/ports` | ✅ |
| A13 | 文档体系（21 份 + 4 份新增治理/ADR） | `docs/`（入口 `docs/INDEX.md`） | ✅ |

## Sprint 1 Deliverables（Core Domain 交付物）

| 类别 | 内容 |
|---|---|
| 基础类型冻结（Task 1） | `kernel/brand.ts`（品牌化类型）、`kernel/identifiers.ts`（17 个聚合 id 类型 + `makeId`/`asId`/`hasIdPrefix` + `DOMAIN_ID_PREFIX`）、`kernel/errors.ts`（+9 个错误码、`domainError()` 辅助） |
| 组织上下文（Task 2/5） | `domain/company.ts`、`domain/pack.ts`（安装/启停/能力解析）、`domain/role.ts`（**不得绑定模型**）、`domain/agent.ts`（**不得绑定厂商**，闭集 slot 白名单） |
| 工作流上下文（Task 3） | `domain/workflow.ts`（容器，接线既有 L2 Template/Version）、`domain/workflow-run.ts`（Run 聚合 + 返工预算 + 恢复点） |
| 执行上下文（Task 4） | `domain/stage.ts`、`domain/task.ts`（L3 机器 + 尝试次数上限） |
| 治理与产物（Task 6） | `domain/artifact.ts`、`domain/validation.ts`（证据不变量 + 质量门）、`domain/approval.ts`（风险分级 + 授权 + 职责分离）、`domain/event.ts`（事件目录 + 信封工厂） |
| 状态分层（STEP 3B） | `domain/run-state.ts`（L1 17 态、暂停/恢复细则、30 条转移规则） |
| 词表冻结（STEP 3A） | `domain/catalog.ts`（`CORE_CONCEPTS` 恰 23 项 + 行业禁词数据） |
| Port 冻结（Task 7） | 新增 `ports/workflow-engine.ts`、`ports/event-store.ts`；共 **11 个**（ADR-0002） |
| 决策记录 | `docs/adr/0002-core-domain-and-port-freeze.md`、`0003-state-layering.md`、`0004-single-writer-workspace.md`、`docs/WORKSPACE_GOVERNANCE.md` |
| 测试（Task 8） | `packages/core/tests/domain/` 10 个文件 + `docs/tests/workspace-governance.test.ts` |

**独立评审（只读）**：首轮结论 **FAIL**（2 BLOCKER + 3 HIGH + 4 MEDIUM + 3 LOW/NIT）；
第一轮修复后复评：**代码级发现全部闭环**，仅剩 1 个文档级 BLOCKER（提交前声称完成、tag 与测试计数
不一致）与 1 个新暴露的 MEDIUM（绑定 tier 段无约束）——均已修复，并在提交后回填哈希使表述成立。

## Sprint 3 Deliverables（Persistence 交付物）

| 类别 | 内容 |
|---|---|
| Core 增量（纯类型） | `ports/command-ledger.ts`（`CommandLedgerPort` + `CommandLedgerRecord`，outcome 为不透明 JSON 快照）；`ERROR_CODES` 新增 `PERSISTENCE_FAILED` |
| UnitOfWork | `packages/persistence/src/durable/unit-of-work.ts`：`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`、全局 FIFO 串行化、`AsyncLocalStorage` 支持嵌套加入外层事务、`committed()`/`rolledBack()` 诊断 |
| SQLite stores | `sqlite-run-store`（含 `resume_point`/`rework_count`/`max_rework`/`failure_reason`/`history_json`）、`sqlite-task-store`、`sqlite-approval-store`、`sqlite-event-store`（`global_position` + `readByRun`）、`sqlite-command-ledger`（`trim` 按 rowid） |
| 组合根 | `openDurableDatabase()`：打开库（WAL/foreign_keys/busy_timeout）→ 应用 **两条校验和迁移链** → 返回所有端口实现（引擎只接收端口） |
| 引擎接线 | `WorkflowEngineDeps.ledger?` / `unitOfWork?`；`inTransaction` 包裹「审批副作用 + run 写 + 事件 + 账本 + trim」，**阶段执行也是一个事务**；缓存只在 COMMIT 后更新；无 `UnitOfWork` 时记 `warn` |
| 迁移 | `migrations/engine/0001_engine_persistence.sql`（runs/tasks/approvals/events.global_position/command_ledger + 索引）；core 链 `0001_init.sql` **未改动** |
| 文档 | `docs/PERSISTENCE.md`、`docs/adr/0006-durable-unit-of-work-and-idempotency.md` |
| 测试 | 仓库根 `tests/sprint3/`（atomicity A/B/C/J、durability D–H、event-order I、migration K、continue-run L、boundary ⑮）+ `tests/support/durable-fixture.ts` |

**独立评审（只读）**：首轮 **PASS WITH CONDITIONS**——1 HIGH（阶段执行的 task 写与 task 事件原先落在事务外）
+ 3 MEDIUM（审批缓存随回滚失配、AGENTS 提前声称完成、无 UnitOfWork 时静默退化）+ 2 LOW + 1 NIT；
**全部已修复并补回归测试**（含"阶段整体回滚"与"整轮执行审计 readByRun"两条新断言）。

## Sprint 4 Deliverables（Workflow Lifecycle 交付物）

| 类别 | 内容 |
|---|---|
| Core 加法式 | `lifecycle/snapshot.ts` 新增 `versionSnapshotHash`（版本身份指纹，随版本行持久化）；**修正** `publishRevision` 转正草案时不重算 `contentHash` 的 Sprint 1 缺陷；版本事件改为按**版本 id** 聚合（模板 id 入 payload）；`createRunSnapshot` 增加"草案不可钉"的真实守卫 |
| 编排层 | `packages/engine/src/lifecycle-service.ts`：createTemplate / saveDraftGraph / publish / openProposal / decideProposal / openRevision / publishRevision / fork / deprecate / archive / lock / unlock / createRun，全部在 `UnitOfWork` 事务内并写事件；含 `authorize` 授权缝与 `LIFECYCLE_AUTHORITIES` |
| 持久化 | `migrations/lifecycle/0001_workflow_lifecycle.sql`（`workflow_templates` / `workflow_template_versions` / `workflow_template_locks` / `workflow_change_requests` / `run_snapshots`）；`sqlite-template-store.ts`（存储层不可变守卫 + 唯一版本号 + 只删草案）与 `sqlite-lifecycle-stores.ts`（锁/提案/快照 + `activeLockOf` / `snapshotOfRun`） |
| 组合根 | `openDurableDatabase({ chains })`：`core`+`engine` 为历史默认，`lifecycle` 显式启用；未启用时生命周期 store 显式拒绝（`PERSISTENCE_FAILED`），不静默返回空 |
| 文档 | `docs/LIFECYCLE_GOVERNANCE.md`、`docs/adr/0007-workflow-lifecycle-governance.md`；`docs/WORKFLOW_LIFECYCLE.md`（既有 Bible）加实现差异说明 |
| 测试 | `tests/sprint4/{lifecycle,governance,restart,boundary}.test.ts` + `tests/support/lifecycle-fixture.ts` |

**独立评审（只读）**：首轮 **PASS WITH CONDITIONS**——5 MEDIUM（① 版本事件 `aggregateType=WorkflowVersion`
却用模板 id，审计按版本查不到；② `snapshotOfRun` 声明同步却返回 Promise；③ 需求⑤⑦的 Review/Fork
映射未记录；④ 服务无授权校验；⑤ 既有 Bible 与实现口径冲突）+ LOW/NIT；**全部已修复**，并新增
"授权缝拒绝发布不产生任何写入"与"按版本 id 可审计"两条断言。

## Sprint 5 Deliverables（Workflow Designer 交付物）

| 类别 | 内容 |
|---|---|
| Core 纯函数 | `lifecycle/change-ops.ts`：`applyChangeOps`（9 个 op：ADD/REMOVE/UPDATE_STAGE、CONNECT/DISCONNECT、SET_ROLE/VALIDATOR/RISK/APPROVAL；不可变、确定、原子、无 IO）+ `assertEditable`；`lifecycle/graph-validation.ts`：10 类校验 + `assertPublishable`（Publish 门） |
| Desktop 应用层 | `apps/desktop/src/workflows.ts`：单入口 `handle(raw)`（首句即 `parseWorkflowRequest`）、20 个 operation、传输上限（文本 512 / Stage 200 / Edge 500 / 列表 64 / ops 200）、生产默认 `defaultRequireRole: true`、真实 `proposal.list` |
| IPC 接线 | `channels.ts` 新增唯一 feature channel `companyos:workflow`（**契约变更**，用户 STEP 3 授权）；`preload.cjs` 只暴露 `workflowRequest(request)`；`main.ts` 惰性打开 `chains: ['core','engine','lifecycle']`、注入 `authorize`（只放行 `SESSION_ACTOR`）并用会话身份**覆盖**渲染层自述的 `actorId` |
| Renderer | `designer-model.ts`（纯投影：Library 行 / Designer 视图 / Compare 行 / 只读文案）+ `designer.tsx`（Library 表 + Stage List/Form/连线/Role/Validator/Risk/Approval/Validate/Submit Review/Publish；Published 只读且提示 Proposal/Fork）+ `bridge.ts`/`App.tsx` 接线 |
| 文档 | `docs/WORKFLOW_DESIGNER.md`、`docs/adr/0008-designer-ui-boundary-and-ipc-contract.md`；`AGENTS.md` §3 更新（含 UI 边界铁律与新的禁止项） |
| 测试 | Core：`change-ops.test.ts`（C/D + 9 op + 原子失败）、`graph-validation.test.ts`（E）；Desktop：`workflows.test.ts`（A/B/F/G/H/I/J/K/L/M/N/Q/R + 生产装配 3 例）；边界：`tests/sprint5/designer-boundary.test.ts`（O/P + 单通道 + 唯一入口） |

**独立评审（只读）**：判定 **PASS WITH CONDITIONS** —— 1 个 DoD 级 BLOCKER（roadmap 抢跑声明了尚不存在的
tag/记录，已在本次回填中先建 tag 再写真实哈希）+ 3 MEDIUM（生产未注入校验目录与授权 → `defaultRequireRole`
与会话身份；`proposal.list` 名不副实 → 改为真实提案）+ 2 LOW（两个 durable 句柄；传输无上限）+ NIT。
**Blocker/High/Medium 全部关闭**，并新增 3 条"生产装配"测试证明修复后的规则在生产路径生效。
评审确认：无第二条写路径、Renderer 未复制规则、Published 三重拦截、所有 IPC 入口都过 schema 校验、
编码损坏已清除、既有测试仅 `channels.test.ts` 一处（用户授权的契约变更，断言强度未降）。

**过程记录（编码事故）**：我曾用 PowerShell 回写 `apps/desktop/src/workflows.ts`、
`packages/core/src/index.ts`、`scripts/check-boundaries.mjs`，宿主是 Windows PowerShell 5.1，
`Set-Content` 以 ANSI 覆盖导致 UTF-8 损坏（在中间 WIP 提交 `9e3f9d0` 中可见）。已在 `90ef618` 全部修复
（字节级校验为有效 UTF-8），并把「改文件只用文件工具，不用 shell 回写」列为纪律。

## Sprint 6 Deliverables（Provider Abstraction 交付物）

| 类别 | 内容 |
|---|---|
| 低成本遗留 ① | **单 durable 句柄**：`main.ts` 只调用一次 `openDurableDatabase({chains:['core','engine','lifecycle','provider']})`，外壳状态 / 工作流治理 / Provider 注册表共用同一连接与同一 `UnitOfWork`（此前两个句柄靠 SQLite 锁兜底）；测试断言 `openDurableDatabase(` 只出现一次 |
| 低成本遗留 ② | **最小 Role → Authority**：Core `AUTHORITIES` 闭集（16 个：workflow.* / run.* / provider.* / secret.*）+ `decideAuthority`（未知名 → `INVALID_ARGUMENT`，缺权 → `PERMISSION_DENIED` 带 `held`）；引擎 `createAuthorizationService` 持久化 `roles` / `role_assignments`（defineRole/assign/revoke/decide/effective） |
| Provider 契约 | `ModelProviderPort`（describe/listModels/health/invoke/stream/secretRefs?）、`ModelInfo`（contextWindow/maxOutputTokens/capabilities/pricing）、`ProviderModelRecord`、`NormalizedProviderError`（12 kind + retryable + retryAfterMs + upstreamCode）、`ProviderRegistryPort` |
| 归一化 | 能力缺失=false（fail-closed）；模型默认名/输出上限/定价；`ERROR_CODE_BY_KIND` 映射（限流/配额→`LIMIT_EXCEEDED`、超时→`TIMEOUT`、上下文→`VALIDATION_FAILED`、能力→`CAPABILITY_MISSING`、鉴权→`PERMISSION_DENIED`）；本地预检（未知模型 / 结构化输出 / 工具调用 / **流式** / 输出上限 / 上下文上限）且失败不触达 provider |
| 密钥边界 | `SecretRef` 指针 + `secret_refs`（**无值列**，逐列断言）+ `createEnvSecretVault`（值只在内存）+ 全出口脱敏；**结果含密钥即拒绝返回**（`PERMISSION_DENIED: Secret material detected`）；全仓 `sk-` 扫描只白名单 `sk-mock-*` |
| MockProvider | 确定性脚本（模型目录/健康/按序输出或失败/流式分片）、无随机无定时器无 IO、记录 `calls`、`setScript()` 热替换（测试 Q） |
| 持久化 | 第四条校验和保护链 `migrations/provider/0001_provider_registry.sql`（providers / provider_models / secret_refs / roles / role_assignments）；core/engine/lifecycle 三条链一字未动（有测试锁定） |
| 文档 | `docs/PROVIDER_ABSTRACTION.md`、`docs/adr/0009-provider-abstraction-and-secrets.md` |
| 测试 | `tests/sprint6/providers.test.ts`（A–Q）、`authorization.test.ts`（授权全路径 + 重启）、`boundary.test.ts`（出厂源码零厂商名、Core/Engine 无 HTTP/定时器、Registry 只依赖 Core、密钥形态扫描、schema 无值列） |

**独立评审（只读）**：判定 **PASS WITH CONDITIONS，无 BLOCKER/HIGH**。MEDIUM-1/2（两处
`as unknown as DomainError` 伪造错误对象，破坏 `Result<T, DomainError>` 契约）与 MEDIUM-5
（`stream()` 未执行 `capabilities.streaming` 声明）、LOW-1（注销不清模型目录）**已修复**；
MEDIUM-3（`provider.*` / `secret.*` 授权目前只有闭集与决策函数，**尚无执行点**）、LOW-2（中文上下文
估算按 chars/4 低估约 4 倍）、LOW-3（Provider 层不写事件，注册/调用无审计轨迹）**作为已知欠账记录**，
列入 Sprint 7 前提（见下）。评审独立确认：出厂源码厂商名零出现、Registry 不是 Router、密钥全出口被挡、
A–Q 无空壳、既有测试零改动、72 文件与 +34 增量自洽。

## Sprint 7 Deliverables（Model Registry 交付物）

| 类别 | 内容 |
|---|---|
| 欠账 ①（授权执行点） | `ProviderRegistry`（register/unregister/health/models → `provider.register`/`provider.read`；invoke/stream → `provider.invoke`）、`SecretVault`（read → `secret.read`；write/remove → `secret.write`）、`ModelRegistry`（register → `model.register`；enable/disable/alias/unregister → `model.write`）全部走 `authorize`；Core `AUTHORITIES` 新增 `model.*`；拒绝时零写入（有断言）；未注入策略只允许并告警一次 |
| 欠账 ②（上下文估算） | `domain/context-estimate.ts`：按 ASCII / CJK / emoji / fenced code / 其他分类计数并逐类向上取整，`conservative: true` 表示上界；接入 provider 预检；测试证明 `你好世界` 由旧口径 1 token 变为 4，且长中文提示会被真实拒绝（`kind: 'context_limit'`） |
| 欠账 ③（Provider 审计） | `provider.registered` / `provider.health_checked` / `provider.invoked` / `provider.failed` + `model.registered` / `model.enabled` / `model.disabled` / `model.alias_bound` 写入同一事件日志；payload 先 `redactValue` 脱敏；测试断言事件序列且不含密钥 |
| Model Registry | Core `domain/model-registry.ts`（`ModelRecord`、`LogicalAlias`、`availabilityOf`、`resolveAlias`、`aliasConflict`、`capabilityProfileOf`）+ Engine `registry/model-registry.ts`（registerFromProvider / unregister / get / list / setEnabled / bindAlias / resolve / aliasList / capabilityProfile / availability / refreshProvider） |
| 不是 Router | 入口必须点名（key 或精确别名）；无候选集、无打分、无回退；别名冲突 → `CONFLICT`；源码与 DDL 扫描无 score/rank/priority/fallback（`tests/sprint7/registry-boundary.test.ts`） |
| 持久化 | 第五条校验和保护链 `migrations/registry/0001_model_registry.sql`（`model_records` + `logical_aliases`，含唯一键与 CHECK）；既有四条链**字节未动**；`chains` 由组合根显式开启 `registry` |
| 组合根 | `apps/desktop/src/main.ts`：单 durable 句柄（五条链）→ 授权服务 → 会话+Role 策略 → 环境密钥库 → Provider 注册表 → Model Registry → 同一 IPC 通道；新增 `models.list/register/enable/disable/alias/resolve` 六个 operation；UI `apps/renderer/src/registry.tsx` 只经 IPC |
| 文档 | `docs/MODEL_REGISTRY.md`、`docs/adr/0010-model-registry-and-no-routing.md` |
| 测试 | `tests/sprint7/model-registry.test.ts`（A–O）、`tests/sprint7/registry-boundary.test.ts`（P/Q） |

**独立评审（只读）**：判定 **PASS WITH CONDITIONS，无 BLOCKER/HIGH**。评审独立确认：Registry 不是 Router
（入口形态 + 源码/DDL 扫描 + 别名冲突语义）、授权执行点生效且拒绝零写入、四类审计事件齐备且脱敏、
CJK 估算真的改变了行为、C 场景"Provider 删除不丢数据"、链独立、UI 无第二真相源；
并对 Sprint 5 的 chain 断言更新（4→5 条链，仍为精确匹配 + 单句柄断言）判定**可接受**。

**未关闭的 4 个 MEDIUM（已记录，未在本次修复；均非 Blocker/High）**：

1. **fail-open 引导授权**：`main.ts` 的 `sessionAuthorize` 在"尚无任何 Role"时放行一切 authority，
   而 ADR-0010 并未记录该引导窗口。→ Sprint 8 前处理：要么在 ADR-0010 明确记录并加显式开关，
   要么首启写入一条 owner Role。
2. **vault 原始 API 可绕过授权**：`SecretResolver.get/set/delete` 不做权限判定（适配器拿到的正是该视图）。
   → 只向适配器暴露 authority-checked 视图，或把原始方法改名并要求显式开关。
3. **审计缺口**：只有带 marker 的 DomainError 会写 `provider.failed`；普通 `Error`（真实 HTTP 客户端最可能的形态）
   与 stream 路径不写事件。→ 两个 catch 分支都写 `provider.failed` 并明确 stream 的计数口径。
4. **`get()` 返回落库行而非派生值**（provider 删除后仍显示 `available`），且 `withDerivedAvailability`
   逐条调用活体 `health()`（会写库、且未传 actorId → 落到 `systemActor`）。→ `get()` 也派生或改名
   `getStored`；列表改读已存 `lastHealth`（无活体探测）；调用方显式传 actorId。

## Sprint 7.1 + 7.5 Deliverables（Registry Hardening + Selection Policy）

### Sprint 7.1 — Sprint 7 评审的 4 个 MEDIUM 全部关闭

| # | 原问题 | 关闭方式 | 证据 |
|---|---|---|---|
| 1 | Bootstrap 授权 fail-open（roles 为空即放行一切） | 新增 `ensureBootstrapOwner()`：首次初始化**显式创建 owner Role 并分配**给会话 actor（全量 authority）；之后窗口关闭——无分配即拒绝，且 bootstrap 只发生一次 | `tests/sprint7/hardening.test.ts` 7.1-1（空表即拒绝、分配后逐条允许、第二次调用 `roles_already_defined`、其他 actor 无收益、重启保留）；ADR-0011 与 `authorization.ts` 注释记录该状态 |
| 2 | SecretVault 原始 API 可绕过授权 | 新增 `SecretAccessView`（`vault.forActor(actorId)`）：`read/write/remove/resolve/names` 全部自校验 `secret.read` / `secret.write`；适配器只能拿到该视图；原始 `SecretResolver` 方法保留给组合根并注明 | hardening 7.1-2（拒绝且不泄密、允许时可读、`names()` 只列名、写入被拒时存储不变） |
| 3 | `provider.failed` 只覆盖带 marker 的 DomainError | 三类失败全部审计：marker DomainError、未标记 DomainError（区分"我方守卫"与"适配器错误"）、普通 `Error`（启发式分类 timeout / unavailable）；`stream()` 的成功前失败与抛错也审计（带 `phase`） | hardening 7.1-3（4 条事件：3×invoke + 1×stream，含 unavailable / timeout / rate_limited，且不含密钥） |
| 4 | `get()` 返回落库行 + 读路径触发活体 health（含隐式 systemActor 提权） | `get()` 返回**派生**可用性；`list()/get()/availability()` **不再调用** `health()`（改读已持久化的 `lastHealth`）；新增**显式** `refreshHealth(providerId, actorId)`（授权 `provider.read` + 审计 `provider.health_checked`）；IPC 增加 `models.refreshHealth` | hardening 7.1-4（读路径 `healthCalls === 0`；refresh 后为 1 且落库 degraded；被拒刷新不探测；Provider 注销后 `get()` 报 unavailable 且不删除数据） |

### Sprint 7.5 — 开放模型研究 + 选择规则（**不实现 Router**）

| 类别 | 内容 |
|---|---|
| 研究 | `docs/OPEN_MODEL_BENCHMARK.md`：覆盖用户要求的全部类别（DeepSeek / Qwen / Llama / Mistral / Kimi / 编码专用 / 工具调用 / 结构化输出 / 本地可部署 / Ollama·llama.cpp·vLLM 生态），26 列规格（License、Params、Ctx、Tool、JSON、Vision、Reasoning、Coding、CodeReview、Chinese、LongCtx、InstrFollow、Latency、VRAM、RAM、Quant、三生态支持、Cloud、Cost、8GB fit、Weakness、Role…），全部标注 `public` 来源与 `unverified` 边界，**不伪造实测分数** |
| Benchmark 契约 | Core `domain/benchmark.ts`：14 个类别（A–N）+ 确定性期望（contains / not_contains / regex / json_keys / manual，**不用 LLM-as-judge**）+ `BenchmarkResult` + `summarizePerformance()`（按类均值 + 无权重总均值，不排序、不标"最佳"）+ `PERFORMANCE_METADATA_PURPOSE = 'display-and-planning-only'` |
| ModelSelectionPolicy | Core `domain/model-selection-policy.ts`：`MANUAL` / `AUTO` / `HYBRID`；作用域 `COMPANY/WORKFLOW/ROLE/TASK`；**冻结优先级阶梯** `Explicit > TaskOverride > Role > Workflow > Company > Router Recommendation > Global Default`；fallback `NEVER / ASK / AUTO_WITHIN_POLICY`（禁止无边界 fallback）；`evaluateManualSelection()` 逐条给出拒绝原因；`hybridCandidates()` 返回候选集与排除原因；`describeAutoPolicy()` 只解释不执行 |
| 服务与持久化 | 引擎 `registry/selection-policy.ts`（savePolicy / get / list / resolveFor / explainManual / hybridView / autoView / recordBenchmarkResults / performanceMetadata，含授权与审计）；第六条校验和链 `migrations/selection/0001_model_selection.sql`（`model_selection_policies` UNIQUE(scope_type, scope_id) + `benchmark_results`，**无 score/priority/fallback 列**） |
| UI | `apps/renderer/src/registry.tsx` 新增 **Model Selection Mode**：`○ Manual ○ Auto ○ Hybrid`；Manual 下拉显示 capabilities/availability/pricing/context + "Check this choice"；Hybrid 六项输入 + Fallback 选择；Auto 显示 "Router will decide within policy" 并说明未实现、只保存配置 |
| 文档 | `docs/MODEL_SELECTION_POLICY.md`、`docs/OPEN_MODEL_BENCHMARK.md`、`docs/adr/0011-model-selection-policy.md` |
| 测试 | `tests/sprint7-5/selection-policy.test.ts`（A–R）；`tests/sprint7/hardening.test.ts`（7.1 四项） |

**测试总数 597 → 620**（+23）；既有测试零删除、无 skip/only/todo；唯一既有测试改动仍是 Sprint 5 的链断言（Sprint 7 评审已判定可接受，本轮再次随链数变化精确更新）。

**本轮评审**：见下方 Independent Review Record（Sprint 7.1+7.5 段）。

## Closeout-7.5（独立评审 + 修复）

**评审判定：PASS WITH CONDITIONS**（11 项重点中 10 项实现正确且有真测试；发现 **1 个 HIGH + 4 个 MEDIUM**）。
评审独立确认：bootstrap 无隐式 fail-open 且只执行一次、`SecretAccessView` 五个方法全过授权、
四类 provider 失败均写审计、`list/get` 零活体探测（`healthCalls===0` 断言）、precedence 常量顺序正确、
MANUAL 从不替换、ASK 不给候选、blockedModels 为有意硬阻断、无隐藏 Router、
`model-selection-policy.ts` 不 import benchmark、UI 无第二真相源、测试只增不减且无 skip/only/删除。

**已修复（全部 Blocker/High/MEDIUM）**：

| 级别 | 问题 | 修复 | 证据 |
|---|---|---|---|
| **HIGH-1** | `main.ts` 只开 5 条链，缺 `'selection'` → 出厂应用**无法存取任何策略**（`models.policy*` 必失败） | chains 补 `'selection'`；`tests/sprint5/designer-boundary.test.ts` 字面量同步为 6 链；`unavailable()` 的提示改为按实际表/链说明（原写死 "lifecycle chain" 是错的） | `main.ts` 单句柄 6 链；sprint5 断言 6 链且仍精确匹配 + 单句柄 |
| MEDIUM-1 | `preflight` / `register` / `refreshSecrets` 失败不写 `provider.failed` | preflight 守卫失败 → `phase:'preflight'`；register 三种失败（内存重复/存储重复/listModels 失败）→ `phase:'register'`；`refreshSecrets` 移入 try → `phase:'secret_refresh'` | `tests/sprint7/hardening.test.ts`：事件 phase 序列 `['preflight','register']` 且 preflight 拒绝时 adapter `calls` 为空 |
| MEDIUM-2 | 解释器与阶梯不一致：`ROUTER_RECOMMENDATION` 不可达；`TASK` 作用域在无 override 标志时回落 `GLOBAL_DEFAULT` | `precedenceLevelOf` 增加 `TASK` 分支；新增 `routerRecommendation` 入参（保留为未来 Router 契约并在文档注明当前不可达） | `tests/sprint7-5`：TASK 策略（无 override）→ `TASK_OVERRIDE`；每个梯级均有可达输入断言 |
| MEDIUM-3 | ADR-0011 未记录 bootstrap；`MODEL_REGISTRY.md` 仍是修前措辞 | ADR-0011 新增 §1b（首启显式 provision owner Role + 此后纯 Role→Authority + 单次 + 并发 single-flight + 冲突转 `CONFLICT`）；`MODEL_REGISTRY.md` 同步订正并声明旧表述作废 | 文档 |
| MEDIUM-4 | bootstrap 非原子 + `ensureWorkflowApi` 无 single-flight；`defineRole` UNIQUE 冲突抛裸 SqliteError | 组合根加 **in-flight promise 记忆化**（并发 IPC 共享同一次构建）；`defineRole` 捕获 UNIQUE → `CONFLICT` 域错误 | `tests/sprint7/hardening.test.ts`：重复 owner key → `CONFLICT`；连续两次 bootstrap → 只 provision 一次且不授予外人 |
| LOW | `refreshHealth` 产生两条 `provider.health_checked` | 去掉注册表层的重复事件（改由 provider 层记录），`>=1` 断言保留 | `model-registry.ts` |
| flake | 曾出现一次全量门禁 `test` 失败（19.8s），复跑两次 620/620 | 按评审建议加固：`vitest.config.ts` 提高 `testTimeout/hookTimeout/teardownTimeout` 到 30s；新 fixture 的 `rmSync` 加 try/catch（Windows `-wal/-shm` 占用）；保持 `>=1` 式容忍而非精确计数 | `vitest.config.ts` |

**仍未关闭（LOW / NIT，已记录）**：
1. **raw vault 无类型屏障**：`ProviderRegistryDeps.secretResolver` 类型仍是 raw `SecretResolver`，
   `forActor` 只是约定 → 接入首个真实适配器时，适配器工厂应**只接受** `SecretAccessView`；
2. **健康未知按 available**（`?? 'healthy'`）：未检过健康时视为可用，属保守/乐观取舍，接入真实适配器前应决定；
3. `unavailable()` 的 `EntityId` 泛型与表名解耦（纯类型层面，无行为影响）；
4. 提交文件数为 26（Sprint 7.1+7.5 主提交；上一轮汇报曾写 27，以 `git show --stat` 为准）。

**评审对"既有测试改动"的更正**：本轮改的是 `tests/sprint7/model-registry.test.ts`（H 段改为"读不探测 + 显式 refresh"、
M 段新增 authority-bound view 断言），两处均为**加强**且保留原断言；`tests/sprint5` 的链断言属 Sprint 7 的改动。

**评审无法验证项（如实接收）**：门禁命令由我执行。**关于"flake"的更正**：首次 `test` 失败当时未被定位，
我误判为时序 flake；Closeout 期间再次失败后**抓到了真实用例名** ——
`docs/tests/handoff.test.ts > does not carry a fabricated commit hash`（断言 `expected null not to be null`），
根因是本文件的"记录值"字段必须包含**真实存在的 40 位提交哈希**，而我一度把该字面量改成了说明文字。
**结论：那是确定性失败，不是 flake**；已修正字段，并把此事作为教训记录（不得以"复跑变绿"替代失败用例名）。
`vitest.config.ts` 的 30s 超时加固保留（对真实负载仍有价值，但**不是**本次失败的成因）。

## Sprint 8 Deliverables（Agent Runtime 交付物）

| 类别 | 内容 |
|---|---|
| Runtime | Core `domain/agent-execution.ts`（8 态状态机 + 13 种错误 kind + 迁移表）、`domain/agent-context.ts`（显式有界 Context）、`domain/prompt-assembly.ts`（确定性 Prompt，FNV-1a `promptHash`）；Engine `runtime/agent-runtime.ts`（`prepare/run/execute/cancel/recoverInterrupted/get/list`） |
| 模型边界 | **Runtime 不选模型**：`modelKey` 必须由调用方给出（MANUAL / 上层绑定 / 未来 Router），缺失 → `MODEL_SELECTION_REQUIRED`（details 带 `routerAvailable:false`）；策略只做**验证**（MANUAL/HYBRID/AUTO 同一路径），Provider 报错**绝不**换模型 |
| 策略门 | scope 链由 Runtime 自行推导（TASK → ROLE → COMPANY → `COMPANY:*`）+ 调用方声明合并；畸形 scope → `INVALID_ARGUMENT`；不传 scopes **无法**绕过 blocked/allowed/provider/capability/cost 策略 |
| 执行状态 | `CREATED/READY/RUNNING/WAITING_EXTERNAL/COMPLETED/FAILED/CANCELLED/INTERRUPTED`，独立枚举/迁移表/持久化列；崩溃恢复 → `INTERRUPTED`（自身 kind，非 TIMEOUT、非可重试），绝不 COMPLETED、绝不重放 |
| 审计 | 7 个 `agent.*` 事件（created/started/provider_invoked/completed/failed/cancelled/interrupted），payload 只带 id + 度量且统一 `redactValue` 脱敏 |
| 持久化 | 第七条校验和保护链 `migrations/agent/0001_agent_runtime.sql`（`agent_executions` 22 列 + `agent_execution_artifacts`），无 secret/token/credential 列；重启后状态/失败/绑定/用量/trace/产物引用全保留 |
| 组合根 | 单 durable 句柄 7 条链；`agent.prepare/execute/get/list/cancel/recover` 六个 IPC operation；`createAgentRuntime` 装配（授权 / 事件 / 密钥脱敏注入） |
| 文档 | `docs/AGENT_RUNTIME.md`、`docs/adr/0012-agent-runtime-and-model-binding.md` |
| 测试 | `tests/sprint8/agent-runtime.test.ts` + `tests/sprint8/runtime-boundary.test.ts`（A–AB，共 40 条） |

**独立评审（只读）**：判定 **PASS WITH CONDITIONS**，**无 BLOCKER/HIGH**；15 项规格逐条确认有真实现与真测试
（评审特别认可 Y"Provider 失败不 fallback"、X"崩溃不误标完成且不重放"、V"密钥四处不泄露"、D"同角色换模型"）。
评审发现的 3 个 MEDIUM **已修复**：

| 级别 | 问题 | 修复 |
|---|---|---|
| MEDIUM-1 | 来源伪造：策略为 AUTO 时把调用方自己命名的模型记成 `source:'ROUTER'`（Runtime 根本没有 Router） | 去掉该分支：只有 `MANUAL` / `TASK_OVERRIDE` / `EXPLICIT_BINDING`；ADR-0012 注明 `'ROUTER'` 在 Sprint 8 不可达；新增测试 |
| MEDIUM-2 | 策略门可绕过：门禁取决于调用方传入的 `scopes`，畸形项被静默跳过、缺省即 `[]`，此时 blocked/allowed/provider/capability/cost **全不判** | Runtime 自行推导 scope 链（TASK/ROLE/COMPANY:`*`）后合并；畸形 scope → `INVALID_ARGUMENT`；新增测试"空 scopes + blocked 模型仍被拒" |
| MEDIUM-3 | 恢复误标：`markInterrupted` 写 `TIMEOUT`（既非事实，又落在可重试集合里） | 新增 `INTERRUPTED` kind/code（**非**可重试）；测试 X 与 ADR-0012/AGENT_RUNTIME 同步 |

**未关闭（LOW/NIT，已记录）**：`agent.read` authority 已声明但 `get/list` 未执行检查（读全部执行记录，含 errorMessage）；
`run()` 不重新验证绑定（prepare→run 之间模型被停用仍会执行，仅 API 级可达）；
`recoverInterrupted` 只扫 500 条；上下文预算缺聚合上限（最终门是 Provider 预检）；
`PROVIDER_KIND_TO_EXECUTION` 与 Provider 词表有漂移（靠 code 兜底）；
`structuredKeys`/`tools` 未做键形状校验；`AgentContext.modelBinding.source` 类型偏宽（`string`）。

## Sprint 9 Deliverables（Tool Registry 交付物）

### 先关闭的 Sprint 8 三项遗留

| # | 遗留 | 关闭方式 |
|---|---|---|
| 1 | `agent.read` 未执行 | `runtime.get(executionId, actorId)` 与 `runtime.list(filter, actorId)` 都走 `agent.read`；IPC `agent.get/agent.list` 强制要求 `actorId` |
| 2 | `run()` 不重新验证 | `run()` 在执行前用**同一** `modelKey` 重走 `selectModel`（enabled / availability / provider / policy）；失败即本次 `FAILED`，**绝不换模型**（测试断言 `stored.modelKey` 未变） |
| 3 | 恢复只扫前 500 条 | `recoverInterrupted()` 改 **200/页分页扫描**（测试：250 条在飞记录全部修复） |

### Sprint 9 本体

| 类别 | 内容 |
|---|---|
| Tool 契约 | Core `domain/tool.ts`：`ToolRecord`（capabilities / input+output schema / riskLevel / requiredAuthorities / timeoutMs / idempotencyMode / auditPolicy / providerKind / adapterRef）+ `RISK_POLICY` + `decideToolApproval` + `describeTool`；端口 `ports/tool.ts`（`ToolPort` describe/invoke + 可选 health/cancel） |
| 权限 | 新增闭集 `tool.register/read/invoke/enable/disable`，**全部有执行点**；`invoke` 逐个检查工具声明的 `requiredAuthorities`（`tool.invoke` 强制注入） |
| 风险 | LOW 直执行 / MEDIUM 强制 STRICT 审计（`requiresValidator` 标志）/ HIGH 必须审批 / CRITICAL **禁止自批**；风险门在 Engine，**UI 无法绕过**（测试 X） |
| Schema | Core 确定性 JSON-Schema 子集校验器；**输入在适配器之前**、**输出在其之后**；畸形输入从不触达适配器（测试 G：adapter 调用为 0） |
| 幂等 | `NONE` / `COMMAND_ID` / `IDEMPOTENT_KEY`；DB **部分唯一索引** + 注册表查重；重放返回记录结果、**不第二次调用适配器**（测试 P/Q） |
| 批准原子性 | `markInvocationApproved` 只记录批准人（状态保持 `WAITING_APPROVAL`，二次批准 `CONFLICT`）+ 存储层**条件更新 claim**：**并发批准只执行一次**（测试"Closeout HIGH-1"） |
| 生命周期 | `REQUESTED → WAITING_APPROVAL → STARTED → {COMPLETED|FAILED|CANCELLED}`，独立于 Agent Execution 与 L1/L2/L3 |
| Runtime 集成 | `runtime.runToolCall(...)` = Model → Tool Call → Tool Result → Runtime，**恰一轮**（无循环/无 next-tool）；`prompt.toolIds` 把被点名工具声明给模型（当前只传名称；真实 descriptor 列为 Sprint 10 项） |
| 审计 | 8 类 `tool.*` 事件 + payload（9 个必需 id 字段 + digest/延迟）+ 统一 `redactValue`；密钥不入 DB/事件/错误（测试 R/S） |
| MockTools | Echo / ReadOnly / Failing / HighRisk / Critical / Slow，全部确定性、零 IO、零破坏性（测试 AB） |
| 持久化 | 第八条校验和保护链 `migrations/tools/0001_tool_registry.sql`（`tool_records` / `tool_invocations` / `tool_invocation_artifacts` + claim 语义）；重启后注册/启停/风险/权限/历史/结果/错误全保留 |
| 组合根 | 单 durable 句柄 8 条链；`tools.list/enable/disable/invoke/approve/invocations` 六个 IPC operation；注入 `timer`（engine 边界门禁用 `setTimeout`）与 `claims` |
| 文档 | `docs/TOOL_REGISTRY.md`、`docs/adr/0013-tool-registry-and-bounded-invocation.md` |
| 测试 | `tests/sprint9/tool-registry.test.ts`（27）+ `tests/sprint9/tool-boundary.test.ts`（11）= A–AB |

**独立评审（只读）**：判定 **PASS WITH CONDITIONS**；规格 1–11 与遗留三项全部确认有真实现与真测试。
发现 **1 个 HIGH + 3 个 MEDIUM，全部已修复**：

| 级别 | 问题 | 修复 |
|---|---|---|
| **HIGH-1** | **并发重复批准 → 重复副作用**：`approve` 只查状态、无幂等检查，两个并发批准会各调一次适配器 | 域守卫加"已批准即 `CONFLICT`"；注册表在批准后做存储层**条件更新 claim**（唯一胜者）；败者返回 `replayed: true`；组合根注入 claim；新增并发测试断言 `mockCalls === 1` |
| MEDIUM-1 | `approve` 不检查 `enabled`：请求后被禁用的工具仍可批准执行 | `enabled` 检查移入共享的 `executeInvocation`，两条路径都过；新增测试 |
| MEDIUM-2 | 文档高估：`prompt.toolIds` 实际只把工具**名称**声明给模型（真实 description/parameters 未进入 PromptPlan） | 订正 `docs/TOOL_REGISTRY.md`，并把"真实 descriptor 进 PromptPlan"列为 Sprint 10 项 |
| MEDIUM-3 | 超时只判 TIMEOUT、**不调用** `ToolPort.cancel()` | 到点后 best-effort `await adapter.cancel?.(id)`；文档明确"超时是判决不是中止，副作用工具必须幂等/可取消" |

**未关闭（LOW/NIT，已记录）**：幂等查重只扫 500 行且存储未翻译 UNIQUE 违例（副作用仍安全：claim 行在调用前落库）；
重放对 FAILED 先例也返回 `ok`（调用方需看 `status`）；HIGH 允许自批（合规，但"人工门"强度依赖自律）；
无 `tool_invocations` 崩溃恢复扫描；`descriptors()`/`describe()`/`health()` 与 `ToolPort.cancel` 的调用面仍窄；
`tools.list` 硬截断 500；`IDEMPOTENT_REPLAY` 错误码尚未发射。

## Sprint 9.1 Deliverables（Tool Runtime Hardening）

| 主题 | 行为 |
|---|---|
| 恢复语义 | `recoverInvocations(actorId)`：`STARTED → INTERRUPTED`（审计 `tool.invocation_interrupted` + `previousStatus`）；`WAITING_APPROVAL` **原样保留**（不自动批准、不自动执行）；报告区分 `interrupted / waitingApproval / retryable`；分页 200 扫描 |
| 绝不自动重试 | `idempotencyMode: 'NONE'` 的 invocation **永不重试**（不进 `retryable`，显式 `retryInvocation` 也返回 `POLICY_DENIED`） |
| 显式重试 | 仅 `INTERRUPTED` + 幂等模式非 NONE；创建**新 attempt**（新行 + `#retry` 派生键），原行保持 `INTERRUPTED` |
| 幂等索引化 | `ToolInvocationIndexPort` 按 key 走唯一索引查询；**未接线直接拒绝**（`PERSISTENCE_FAILED`，不再回退内存扫描）；UNIQUE 冲突 → `CONFLICT`（`kind: IDEMPOTENT_REPLAY`），裸 `SqliteError` 不会逃出 |
| 重放诚实性 | 命中重放返回 `replayed: true` + `originalInvocationId` + `originalStatus`，发射 `tool.invocation_replayed`；**FAILED 的原调用重放后仍是 FAILED** |
| 分页 | `list({limit, cursor})` → `{items, nextCursor}`（默认 50 / 上限 200 / 畸形游标 `INVALID_ARGUMENT`）；`descriptors()` 内部游标分页 |
| Descriptor 进 Prompt | `PromptPlan.toolDescriptors`（toolId/name/description/parameters/capabilities/riskLevel），**无** adapterRef/权限/secret；按 toolId 排序 ⇒ 相同 descriptors 相同 `promptHash`；模板 `agent-prompt/v2` |
| HIGH 自批 | ADR-0013 §15：**有意设计**（HIGH 可自批、CRITICAL 禁止），测试 N/O 锁定；未来可升 `tool.approve` authority |
| 迁移 | `migrations/tools/0002_tool_invocation_recovery.sql`（重建表放宽 status CHECK + 重建索引；`0001` 校验和未动） |
| 组合根 | 注入 `claims` + `invocationIndex`；`tools.list` 支持分页游标；新增 `tools.recover` / `tools.retry` 两个 operation |
| 测试 | `tests/sprint9-1/tool-hardening.test.ts`（A–O，15 条）；全仓 82 文件 / **721** 用例 |

**独立评审（只读）**：判定 **PASS WITH CONDITIONS**（§一–§七全部有真实现，A–O 齐备，**无 Blocker/High**）。
发现 **3 个 MEDIUM（均为"测试名不副实"）与 4 个 LOW，已全部处置**：

| 级别 | 问题 | 处置 |
|---|---|---|
| MEDIUM-1 | 测试 I 号称覆盖 UNIQUE 翻译，实际只走 replay 路径 | 重写：用**索引故意 miss 的注册表**触发写入冲突，断言 `CONFLICT`/`ALREADY_EXISTS` + `kind: IDEMPOTENT_REPLAY` |
| MEDIUM-2 | 测试 L 号称校验 `promptHash`，实际未调用 `assemblePrompt` | 重写：真实调用 `assemblePrompt` 两次断言 hash 相同，并**反转 descriptor 顺序**断言 hash 不变，另断言模型看到的 parameters 就是 inputSchema |
| MEDIUM-3 | 测试 G 的"未重跑"断言恒真（适配器未绑定、计数键不匹配） | 修正：派生 spec 绑定真实失败适配器，用基础计数键断言"调用次数未增加" |
| LOW-1 | 评审认为 `approve()` 不查 `enabled`（9.0 遗留） | **实为已关闭**：enabled 门在共享的 `executeInvocation` 内（`registry.ts:749-756`），`approve` 路径同样经过；sprint9 测试"Closeout MEDIUM-1: a tool disabled while approval is pending is refused"即为证据 |
| LOW-2 | 重放对 FAILED 先例返回 `ok: true` | 保留诚实语义（`status`/`originalStatus` 忠实），并在 `docs/TOOL_REGISTRY.md` §7b 明确"**调用方必须按 `status` 分支**，不能只看 `ok`" |
| LOW-3 | `descriptors()` 静默截断 200 | 改为内部游标循环取全 |
| LOW-4 | `invocationIndex` 缺省时仍回退 500 行扫描 | **移除回退**：未接线即 `PERSISTENCE_FAILED`（no scan, no silent partial answer） |

**未关闭（NIT）**：`#retry` 派生键是确定性的——对同一条被中断 invocation 连续重试会命中第一次重试的 replay；
重试应"从最新 attempt 起链"（已记入文档待 Sprint 10 处理）；`PromptPlan.toolDescriptors` 直接引用
`record.inputSchema`（未拷贝）；invocation 分页按 `created_at`，固定时钟下大量平局依赖 SQLite 隐式 rowid 稳定。

## Sprint 9.1.2 Deliverables（NIT Hardening）

| 主题 | 行为 |
|---|---|
| 连续 Retry 链 | 每次显式 `retryInvocation()` 基于**最新 attempt** 生成新身份：新 `id`、`parentInvocationId`、稳定 `rootInvocationId`、单调 `attemptNumber`；幂等键 `<base>#retry-<n>`（占用则继续 +1；**50 次都占用 → `CONFLICT`**，绝不静默复用）；**第 N 次不会误命中第 N-1 次 replay**；NON-IDEMPOTENT 仍禁止 |
| Descriptor 快照 | `assemblePrompt` 对 `parameters` 做 JSON 深拷贝 + 递归 `Object.freeze`；`tools`/`structuredKeys` 也冻结；`promptHash` 基于快照 ⇒ 外部 mutation 不改变已产出的 plan/hash |
| 分页稳定排序 | 显式 `ORDER BY created_at DESC, id DESC`（+ 索引 `idx_tool_invocations_stable_order`）；`listInvocations({limit,cursor,executionId?,toolId?,rootInvocationId?})` → `{items,nextCursor}`（默认 50 / 上限 200 / 畸形游标 `INVALID_ARGUMENT`）；**1000 条同时间戳跨页不重复、不丢失、顺序不漂移** |
| 迁移 | `migrations/tools/0003_tool_invocation_attempts.sql`（ADD COLUMN 三列 + 回填 + 链索引 + 稳定序索引；`0001`/`0002` 校验和未动） |
| 测试 | `tests/sprint9-1-2/nit-hardening.test.ts`（7 条：A–F 链、老 attempt 重试、并发重试、NON-IDEMPOTENT 拒绝、G/H 快照不可变、I–K 1000 条分页）；全仓 83 文件 / **727** 用例 |

**独立评审（只读）判定：`PASS`，无 Blocker / 无 High** —— §一–§三 均确认为真实现 + 具区分性测试
（评审特别确认：attemptNumber 单调、parent/root 在"重试老 attempt"下正确、派生键不会命中 n-1、
并发靠 UNIQUE 兜住不重复副作用、深拷贝覆盖嵌套 + freeze、1000 条分页的断言"恰等于 id 降序"具区分性、
迁移 0003 安全且前两条链校验和未变）。

**处置**：

| 级别 | 评审发现 | 处置 |
|---|---|---|
| MEDIUM-1 | "`approve()` 仍不检查 `enabled`" | **误报（前轮已闭环）**：enabled 门在共享的 `executeInvocation`（`registry.ts` "The enabled gate is checked HERE"），`approve` 同样经过；`tests/sprint9/tool-registry.test.ts` 的 "a tool disabled while approval is pending is refused" 即证据 |
| MEDIUM-2 | "UNIQUE 翻译仍无用例" | **误报（9.1.1 已修）**：测试 I 用"索引故意 miss 的注册表 + 真实适配器"构造真实写入冲突，断言 `CONFLICT`/`ALREADY_EXISTS` + `kind: IDEMPOTENT_REPLAY`（`blindRegistry` + `invocationIndex: { findByIdempotencyKey: async () => null }`） |
| MEDIUM-3 | "G 的 `mockCalls` 恒为 0" | **误报（9.1.1 已修）**：G 现绑定 `adapterRef: 'mock.failing'` 并用基础键 `mockCalls('mock.failing')` 断言"调用次数未增加" |
| NIT-1 | 派生键 50 次探测用尽后静默复用 | **已修**：用尽即 `CONFLICT`（绝不静默 replay） |
| NIT-3 | `tools`/`structuredKeys` 未冻结 | **已修**：`Object.freeze` |
| LOW-4 | 并发 retry 无测试 | **已补测**：两次并发 retry 同一 attempt → 恰一次副作用 |
| NIT-4 | ADR 未记录端口形状变更 | **已修**：ADR-0013 §16 补端口形状（`attempt` / parent/root/attemptNumber / `ToolInvocationPage`） |
| LOW-1/LOW-3 | 重放按 `status` 分支的文档要求；游标 keyset 的时钟回拨风险 | **已记录**：`docs/TOOL_REGISTRY.md` §7b 要求按 `status` 分支；ADR-0013 §18 记录 keyset 游标为未来改进 |
| LOW-2 | `descriptors()` 截断 200 | **前轮已修**（内部游标循环取全，评审读到的是旧版本） |

## Sprint 10A Deliverables（Model Router ADR + Contract，**只设计不实现**）

| 交付物 | 内容 |
|---|---|
| ADR | `docs/adr/0014-model-router-architecture.md`：职责边界（改 Policy / 绕 blocked / 覆盖人工选择 / 调 Provider / 执行 Agent 全部禁止）· 三模式语义 · 冻结优先级（Router Recommendation 不得覆盖前五层；`blockedModels` 硬阻断，显式选择也不能越过）· 候选流水线（Hard/Ranking 结构分离）· ranking 信号与 benchmark 上限 · historical 契约 · 五键 tie-break · fallback/unavailable/no-candidate · risk/diversity 钩子 · 版本与 provenance · 审计事件 · human override · **12 场景问答 A–L** · "10A 不实现"声明 |
| 文档 | `docs/MODEL_ROUTER.md`：ReasonCode 目录（**24 正面 + 14 拒绝 = 38**，闭集，禁止自由文本理由）· Explainability 模型 · 流水线 · fallback/override/diversity 契约 · 端口与**未实现声明** · 已知限制 |
| Core 契约 | `domain/model-router.ts`：`RouterRequest` / `ModelRecommendation` / `CandidateEvaluation` / `RejectedCandidate` / `RejectionSummary` / `RouterProvenance` / `FallbackDecision` / `HumanOverride*` / `OverrideRecord` / `ModelDiversityConstraint` / `RouterRiskConstraint` / `ROUTER_V1_RANKING`（唯一 ranking 目录，benchmark `maxWeight = 0.15`）/ `ROUTER_PIPELINE` / `TIE_BREAK_KEYS` |
| 纯规则 | `applyHardFilters`（按冻结顺序执行 11 个硬过滤并记录拒绝理由）· `compareTieBreak`（五键全序，字典序兜底）· `decideFallback` · `routerUnavailableOutcome` · `noCandidateOutcome` · `manualOutcome` · `applyHumanOverride` / `overrideRecord` · `sampleConfidence`（无样本中性 / 小样本降权 / ≥20 满分）· `effectiveBenchmarkWeight`（封顶 + stale×0.5 + external×0.75）· `checkDiversity` |
| 端口 | `ports/model-router.ts`：**只有一个方法** `recommend(request)`，**全仓无实现、组合根未装配、Runtime/Tool Registry 不依赖** |
| 事件类型（未发射） | `router.requested` / `candidates_built` / `recommendation_created` / `no_candidate` / `override_requested` / `override_confirmed`（发射方登记为 `model-router:S10`，10B 才发射） |
| 测试 | `tests/sprint10a/router-contract.test.ts`（A–S，20 条）；全仓 84 文件 / **748** 用例 |
| 提交 | 首次提交 `8126750`（其 lint 曾失败）→ 修正提交 **`030d4c5`**（Core 词汇法中文化 + 文档可达性 + roadmap/AGENTS 回填），**tag `sprint-10a.0.0` 指向 `030d4c5`** |

**独立评审状态（如实记录）：Independent Review 仍未完成** —— 评审基础设施连续**三次**运行中断：
（1）原评审 agent 首次崩溃；（2）重发后再次失败；（3）**新起一个只读 reviewer subagent 同样失败且无收尾消息**。
因此 `sprint-10a.0.0` 与 `sprint-10a.0.1` 都**建立在自检之上、不是独立评审之上**；
**补齐独立评审是下一轮第一优先事项，且 10B 实现前必须先完成**。

## Closeout-10A Deliverables（STEP 2/3/4 已实施）

| STEP | 内容 |
|---|---|
| STEP 2 数值策略冻结 | Core `ROUTER_V1_RANKING`（7 个信号 × 六项事实：`source` / `missing: SKIP_AND_RENORMALISE` / `normalization` / `weight+maxWeight` / `tieBreak` / **`canBreakHardFilter: false`**）+ `ROUTER_V1_WEIGHTS`（**总和恰为 1.00**）+ `routerV1Policy()`（阶段顺序 `HARD_FILTERS → USER_PREFERENCE → PROVIDER_HEALTH → CONTEXT_HEADROOM → COST → LATENCY → HISTORICAL_PERFORMANCE → BENCHMARK → STABLE_TIE_BREAK`）；benchmark 权重 **0.10（硬上限 0.15）**；**缺数据 = 跳过并重归一化**（不是记 0）⇒ 全部可选信号缺失时仍能工作 |
| STEP 3 Policy View 统一派生 | Core `RouterPolicyView` + `deriveRouterPolicyView()`（确定性 + digest）+ `assertDerivedPolicyView()`（拒绝手工拼装/派生后篡改）；`RouterRequest` **移除**散落策略字段，改收 `policyView`；引擎 `selectionPolicyService.routerPolicyView({scopes, requiredCapabilities, actorId})`（授权 `model.read`）；**Runtime / Tool Registry / UI 均不拼 policy 列表**（边界测试） |
| STEP 4 契约冻结 | `routerVersion = 'model-router/v1'`；冻结 `RouterRequest / RouterPolicyView / CandidateEvaluation / RejectedCandidate / ModelRecommendation / RouterProvenance / OverrideRecord / FallbackDecision / ModelDiversityConstraint / RouterRiskConstraint / ReasonCode`；破坏性改动必须升版本 + 新 ADR（ADR-0014 §20–23 记录） |
| 测试 | 新增 `tests/sprint10a-open/policy-view-freeze.test.ts`（11 条：派生确定性 / 篡改拒绝 / 无 policy 可用 / requirements 合并 / Runtime 与 UI 不拼 policy / 六项事实 / 权重与顺序 / tie-break 参与面 / 全缺数据仍工作 / 冻结名导出 / ADR 声明）；总计 S10A 相关 **31 条** |
| 门禁 | `pnpm check` 5× PASS（85 文件 / **759** 用例）·`pnpm test:scripts` 22/22·工作区干净 |

**自检清单（标注：自检，非独立评审）**——逐条核对用户规格并留存证据：

| # | 检查项 | 自检结论（证据） |
|---|---|---|
| 1 | 是否真的没有实现 | `packages/engine/src` 与 `apps/*/src` 中 `ModelRouterPort` / `.recommend(` / `applyHardFilters` 命中数 **0** |
| 2 | 契约内是否有选择/排序实现 | `model-router.ts` 不含 `selectModel(` / `rankModels(` / `scoreModel(` / `bestModel(` |
| 3 | 流水线顺序 | `ROUTER_PIPELINE` 14 段与规格逐段一致；Hard 段止于 `CANDIDATE_SET`；Presentation 段仅后两段（测试断言） |
| 4 | 被淘汰者复活 | `candidates` 与 `rejected` 互斥（测试 F 断言无交集 + 顺序断言） |
| 5 | blockedModels 硬阻断 | `manualOutcome`（走 `evaluateManualSelection`）与 `applyHardFilters`（`MODEL_BLOCKED`）两处都拒（测试 C） |
| 6 | MANUAL 不经过 Router | `routerAppliesTo('MANUAL') === false` + 出参 `MANUAL_NOT_ROUTED`（测试 A） |
| 7 | HYBRID 不越界 | allowedModels/allowedProviders 均为硬过滤；fallback 候选恰等于已过滤集（测试 D/K） |
| 8 | fallback 语义 | NEVER→STOP、ASK→ASK_USER（两者候选为空）、AUTO_WITHIN_POLICY→AUTOMATIC_WITHIN_CANDIDATES（测试 I/J/K） |
| 9 | unavailable / no-candidate | §十四 行为表落实；no-candidate 返回 `NO_ELIGIBLE_MODEL` + `{checked, byReason, summaryText}`（测试 G/H） |
| 10 | benchmark / historical | 缺失中性、上限封顶、stale/external 只减不增、小样本降权（测试 L/M） |
| 11 | 确定性 | tie-break 全序 + `applyHardFilters` 相同输入相同输出（测试 O） |
| 12 | human override | 合法选择不被阻止，记录 recommendation + final selection + agreement（测试 P） |
| 13 | ADR A–L | ADR-0014 §18 逐条回答（含 H quota、I diversity、J benchmark 缺失、K 小样本、L tie） |
| 14 | 词汇法 | Core 中行业名词被替换为 `DIFFERENT_FROM_PRIOR_ROLE_SELECTION`（首次提交因此 lint 失败，已修，ADR-0014 §14 记映射） |
| 15 | 门禁 | `pnpm check` 5× PASS·`pnpm test:scripts` 22/22·工作区干净（真实输出，非声明） |

## Sprint 10A.0.2 Deliverables（Router Contract Hardening — 把文档承诺变成结构强制）

| 评审条件 | 修复结构 |
|---|---|
| **HIGH-1** MANUAL 无强制门 | Core `assertRouterRequestAllowed(request)`：拒绝 `selectionMode==='MANUAL'` / `manualModelKey` 非空 / 视图 mode=MANUAL → `MANUAL_NOT_ROUTED`；`applyHardFilters` 入口顺序 = 该规则 → `assertDerivedPolicyView` → 硬过滤；ADR-0014 §24.1 冻结"`recommend()` 第一条规则必须是它" |
| MEDIUM-1 防篡改门是死代码 | `applyHardFilters` 改为 `Result<HardFilterOutcome, DomainError>` 并在入口调用 `assertDerivedPolicyView`；digest 覆盖字段由 5 增至 **7**（新增 `maxCost`/`maxLatency`）；篡改 8 种字段的组合测试全部拒绝 |
| MEDIUM-2 两套 ranking 目录 | 删除旧 10 键 `RANKING_SIGNALS`（`missing:'NEUTRAL'`）；`ROUTER_V1_RANKING` 为**唯一真相源**；缺失语义统一 `SKIP_AND_RENORMALISE`；`V1_NOT_RANKED_SIGNALS`（`requiredCapabilityFit`/`reviewPassRate`/`reworkRate`）+ `V1_NOT_RANKED` 标记；`RANKING_HARD_CONSTRAINTS` 改为阶段名 |
| MEDIUM-3 假 latency 阶段 | `LATENCY_FILTER_MODE='NO_DATA_NO_HARD_FILTER'`；`HardFilterOutcome.latencyFilter` 显式声明；`LATENCY_LIMIT_EXCEEDED` producer = `FUTURE`；新增解释码 `LATENCY_DATA_UNAVAILABLE`；测试证明 `maxLatency` 在 v1 不淘汰候选 |
| MEDIUM-4 无不变量 | Core `validateRecommendation()`（6 种 decision 的一致性规则）→ `RECOMMENDATION_INVALID`；J/K/L/M 组测试覆盖非法组合 |
| MEDIUM-5 三个解读入口 | `manualOutcome(request)` 与 `applyHumanOverride({policyView})` 改为读取**派生视图**（`RouterPolicyView` 结构满足新 `SelectionRules`），与 Router 共用同一 `evaluateManualSelection` |
| LOW-2 名义候选集 | `FilteredCandidateSet`（brand 符号不导出）+ `assertRankingInput(set)`；`// @ts-expect-error` 证明裸数组不可传入 |
| §八 producer 目录 | `ROUTER_REASON_PRODUCERS` 覆盖全部 **38** 个码（24 正面 + 14 拒绝）；`HARD_FILTER_EMITTED_REASONS`（11 个）与 producer 标注一致性由测试保证；`MODEL_NOT_REGISTERED`/`PROVIDER_UNAVAILABLE` = `PROVIDER_LAYER` |
| §九 snapshotVersion | 语义版本（`policyId@content-digest`，参与 digest）与 provenance 时间戳（`source.generatedAt`，不参与 digest/语义）分离；测试证明时间戳变化不改变 digest |
| 测试 | 新增 `tests/sprint10a-0-2/contract-hardening.test.ts`（A–R：27 条）；三套 router 测试合计 **58 条**；全仓 86 文件 / **786** 用例 |
| 门禁 | `pnpm check` 5× PASS · `pnpm test:scripts` 22/22 · 工作区干净 |

**工程事故（如实记录）**：本轮我曾用 PowerShell `Set-Content` 回写测试文件，导致 UTF-8 被写成 ANSI
（`U+FFFD` 替换字符，Sprint 5 同类事故重演）。我立即 `git checkout --` 该文件、Node 校验
`replacement_char_present=false`，随后**只使用文件工具**重做全部编辑；提交前再次校验四个关键文件无损坏。

## Sprint 10A.0.3 Deliverables（Router Version & Digest Hardening — 关闭评审 1 HIGH + 4 MEDIUM）

| 评审发现 | 修复结构 |
|---|---|
| **HIGH** `snapshotVersion` 时钟绑定 | `snapshotVersion = <policyId\|'no-policy'>@<contentDigest>` 由 `deriveRouterPolicyView` **自己计算**；`DeriveRouterPolicyViewInput.snapshotVersion` 变成**被忽略的弃用别名**；`assertDerivedPolicyView` 交叉校验版本；引擎 `routerPolicyView()` 只传 `generatedAt`；时间戳仅进 `source.generatedAt`（不入 digest/语义） |
| MEDIUM-1 digest 顺序盲 | `contentDigestOf` 分类规范化：集合字段排序、**`preferredModels` 保序**、数值 `maxCost/maxLatency`、标量 `policyId/mode/scopeType/scopeId/fallback`；`[a,b]` 与 `[b,a]` digest 必然不同。**顺带修复真实缺陷**：`createPolicy` 曾用 `normalizeList` 排序 `preferredModels` → 改用 `normalizeOrderedList`（保序） |
| MEDIUM-2 digest 未覆盖 source | 上述标量纳入 digest ⇒ 篡改 `mode(MANUAL↔AUTO)`/`fallback`/`scopeType`/`scopeId`/`policyId`/`snapshotVersion` 一律 `VALIDATION_FAILED`，无法绕过 HIGH-1 的 mode 门 |
| MEDIUM-3 视图丢字段 | 顶层权威 `scopeType/scopeId/fallback`（`source.fallback` 移除，只留一个权威字段）；`SelectionRules` 对应字段必填；缺失必需字段 → `VALIDATION_FAILED`；`evaluateManualSelection` 仅剩 `policy === null ? 'NEVER' : policy.fallback` 这一处合法默认（无 `policy?.allowFallback` 补洞） |
| MEDIUM-4 无候选不变量 | `NO_ELIGIBLE_MODEL` 需 `selected === null` **且**（`rejectedCandidates.length > 0` **或** 显式 `rejectionSummary`）；新增 `ModelRecommendation.rejectionSummary`；评审反例（rejected=[] + evaluations 非空）现在必然 `RECOMMENDATION_INVALID` |
| §六 候选集 | `FilteredCandidateSet` 收紧为**带 brand 的数组类型**（`readonly ModelRecord[] & brand`）：`HardFilterOutcome.candidates` 即该类型，**不存在未 brand 副本**；`assertRankingInput` 是唯一排序入口 |
| §七/§八 统一解释 | `SelectionRules` 正式导出 + `selectionRulesFromPolicy` 唯一适配点 + `rulesExcludeCandidate` 共享排除判定；`hybridCandidates`/`describeAutoPolicy` 改为消费 `SelectionRules` 并复用该判定（仅保留 presentation 标签）；Runtime 与 Policy Service 均走适配器 |
| §九/§十 | `V1_NOT_RANKED_SIGNALS` 每条带 `marker: 'V1_NOT_RANKED'` + `note`；删除死常量 `RANKING_HARD_CONSTRAINTS_LEGACY` |
| §十一 | ReasonCode 计数修正为 **38**（24 正面 + 14 拒绝），tuple length + producer 完整性测试锁定 |
| §十二 测试质量 | 替换两条恒真断言：改为断言端口**必须**声明 `assertRouterRequestAllowed` 与 `validateRecommendation`（实现回退即红）+ 伪造 digest 必须失败 + 顺序敏感 digest |
| §十三 编码纪律 | 本轮新增规则：**禁止用 shell 重写项目文本文件**（AGENTS.md §5.8）；提交前扫描 U+FFFD |
| 测试 | 新增 `tests/sprint10a-0-3/version-digest-hardening.test.ts`（A–T，26 条）；四套 router 测试合计 **84 条**；全仓 **87 文件 / 812 用例** |

## Sprint 10A.0.4 Deliverables（Final Closeout — 关闭新增 2 MEDIUM + LOW/文档/测试债务）

| 评审发现 | 修复结构 |
|---|---|
| MEDIUM-1 判定分歧 | 新增唯一权威纯规则 `evaluateCandidateAgainstSelectionRules(candidate, rules, context)`：MANUAL / Override / HYBRID / AUTO presentation / Router 全部经它判定；`rulesExcludeCandidate` 与 `isCandidateAdmissible` 是薄包装；**两张单一映射表** `EXCLUSION_TO_MANUAL_REFUSAL`（事实码→MANUAL refusal）与 `SELECTION_EXCLUSION_TO_ROUTER_REASON`（事实码→Router ReasonCode）；`UNKNOWN_CAPABILITY` 降级为 MANUAL 侧标签，**事实码恒为 `CAPABILITY_MISSING`** |
| MEDIUM-2 结构校验缺失 | 新增 `validateRouterPolicyViewShape(view)`：先校验 16 个必需字段的存在性/类型/枚举（`MANUAL|AUTO|HYBRID`、`NEVER|ASK|AUTO_WITHIN_POLICY`、`COMPANY|WORKFLOW|ROLE|TASK`），再规范化、再算 digest、再交叉校验 `snapshotVersion`；非法/缺失一律 `VALIDATION_FAILED`，**整体 try/catch ⇒ 无 native 异常逃逸**（含 Proxy 恶意对象测试） |
| LOW null 歧义 | 类型化 digest token：`null`/`undefined`/`num:<v>`/`bool:<v>`/`str:<len>:<v>`，集合与保序列表带 `set:`/`ord:` 前缀 ⇒ `null` vs `"null"`、`0` vs `"0"`、`false` vs `"false"` 不可能碰撞（有碰撞测试） |
| LOW frozen 声明不符 | `deriveRouterPolicyView` **真的冻结**返回对象、`source` 与五个数组 |
| LOW 惰性测试 | `fallback` → **`allowFallback`** 真实字段篡改（并断言 fallback/digest/snapshotVersion 三者同步变化） |
| LOW NEUTRAL 检测 | 改为语义断言 `ROUTER_V1_RANKING.every(s => s.missing === 'SKIP_AND_RENORMALISE')` + 公开表面无第二目录（源码扫描仅作补充） |
| LOW 文档陈旧 | `MODEL_ROUTER.md` 改正旧目录/NEUTRAL 描述与计数；`PROJECT_HANDOFF.md` 计数改为 **24 正面 + 14 拒绝 = 38**、删除把旧目录当现状的记录；ADR §26 描述与修复后代码一致（不再过度声明） |
| 集成守卫 | 结构性集成守卫测试锁定引擎 `routerPolicyView()` 只传 `generatedAt`、**不构造 `snapshotVersion:`**、走 `selectionRulesFromPolicy`（防"Core 修好、生产入口没跟上"回归） |
| 测试 | 新增 `tests/sprint10a-0-4/final-closeout.test.ts`（A–R，32 条）；五套 router 测试合计 **116 条**；全仓 **88 文件 / 844 用例** |

## Sprint 10A.0.5 Deliverables（Mapping & Docs Truth Closeout — 关闭唯一 HIGH + 关键 MEDIUM + 真实性债务）

| 项目 | 修复结构 |
|---|---|
| **HIGH** 范围外 vs 硬阻断 | 事实层拆分为两个事实：`MODEL_BLOCKED_BY_POLICY`（命中 `blockedModels`，不可被显式选择越过）与 **`NOT_IN_ALLOWED_RANGE`**（仅范围外，可被显式选择豁免）。MANUAL 侧两者保留同一展示标签（兼容），Router 侧分别映射为 `MODEL_BLOCKED` 与 `NOT_IN_CANDIDATE_SET`。`SELECTION_EXCLUSION_CODES` = 8；Router ReasonCode **仍为 38**（复用既有 `NOT_IN_CANDIDATE_SET`） |
| MEDIUM 测试无效 | 跨路径测试改为**真实调用** `deriveRouterPolicyView → applyHardFilters`，并断言 range 情形只能得到 `NOT_IN_CANDIDATE_SET`、blocked 情形只能得到 `MODEL_BLOCKED`，且两者结果不相等（映射回退即红） |
| 异常边界 | `assertDerivedPolicyView` 将 shape → derivedBy → digest → snapshotVersion 交叉校验**整体**包在 try/catch：任何不可信输入（含"前几次读取正常、之后 getter 抛错"的有状态 Proxy）只返回 `VALIDATION_FAILED` |
| Shape 收紧 | `scopeId` 必须 `string | null` 且 trim 非空（空串/数字/对象一律拒绝）；`maxCost`/`maxLatency` 必须 **finite** 或 `null`（`NaN`/`Infinity`/`-Infinity` 拒绝） |
| 结构碰撞 | 新增集合与保序列表的结构碰撞测试：`blockedModels ['a,b']` vs `['a','b']`、`requiredCapabilities ['x,y']` vs `['x','y']`、`preferredModels ['a|b']` vs `['a','b']` 均不碰撞；标量 `null`/`"null"`/`0`/`"0"` 碰撞测试保留 |
| 运行时冻结 | 新增断言：`Object.isFrozen(view)`、`Object.isFrozen(view.source)`、五个数组全部 frozen，且 mutation 尝试抛错且不改变视图/digest |
| 文档真实性 | ADR 计数改 **24 正面 + 14 拒绝 = 38**；删除"Router 硬过滤全部经由统一规则"的不实表述，改为真实结构（事实由统一规则产出，Router 负责映射 + registry/runtime 级过滤）；`MODEL_ROUTER.md` 只展示 `ROUTER_V1_RANKING` + `V1_NOT_RANKED_SIGNALS`（删除旧 10 键目录作为现状的描述）；handoff 字段数改 **16** |
| 评审记录 | 本次把 **10A.0.3** 与 **10A.0.4** 的完整评审结论（verdict / Blocker / High / Medium / ALLOW 10B / 未关闭项）写入本文件 |
| 测试 | 新增 `tests/sprint10a-0-5/mapping-truth-closeout.test.ts`（A–T，16 条）；六套 router 测试合计 **132 条**；全仓 **89 文件 / 860 用例** |

## Sprint 10B Deliverables（Deterministic Model Router v1 实现）

| 交付物 | 内容 |
|---|---|
| 路由器实现 | `packages/engine/src/router/deterministic-router.ts`：`createDeterministicModelRouter()` 实现 `ModelRouterPort.recommend`，严格 `assertRouterRequestAllowed → applyHardFilters → rankCandidates → selectWinner → validateRecommendation → 审计`；MANUAL 首条规则硬拒；零候选返回 `NO_ELIGIBLE_MODEL` + `rejectionSummary`；`fallbackContract()` 只产出契约、**从不执行** |
| 排名引擎 | `packages/core/src/domain/model-router-ranking.ts`：只读 `ROUTER_V1_RANKING`/`ROUTER_V1_WEIGHTS`；逐信号 `signalScores`/`availableWeights`/`normalisedScore`/`reasonCodes`/`tieBreakFacts`；缺失=跳过并重归一化；health 1.0/0.5/0.25；cost/latency 集内 min/max 反演（全等 0.5）；historical = `successRate × sampleConfidence`；benchmark 上限 0.15 + stale ×0.5 / external ×0.75 |
| Core 契约 | `CandidateEvaluation` 增加排名明细（additive）；`ports/router-decision.ts` 定义 `RouterDecisionRecord`/`RouterDecisionStorePort`（避免 persistence→engine 反向依赖） |
| 持久化 | `migrations/router/0001_router_decisions.sql` + `createSqliteRouterDecisionStore`/`RouterDecisionReadPort` + `router` 迁移链接入 durable 层（`MigrationChainName`/`ALL_CHAINS`/`migrationsDirFor`/迁移报告） |
| 组合根 | `apps/desktop/src/main.ts` 装配 `DeterministicModelRouter`（审计走结构化日志适配器）；**Runtime 不构造、不调用 Router**（源码级边界测试） |
| 审计 | 六个 `router.*` 事件 + 白名单 payload（requestId/taskId/roleId/selectionMode/routerVersion/policySnapshotVersion/modelRegistryRevision/candidateCount/rejectedCount/selectedModelKey/reasonCodes/traceId；无 secret/prompt/正文） |
| 测试 | `tests/sprint10b/router-implementation.test.ts`（A–AT，30 条）；全仓 **90 文件 / 890 用例** |
| 未完成（10B.1 backlog，已在 ADR §28.3 记录） | ① 组合根请求 `'router'` 链（会触及三条既有边界断言的精确列表，需同批更新）；② `router.*` 事件的**持久化**发射绑定（当前为结构化日志）；③ `router.recommend` 的 IPC 曝光 |

## Sprint 10B.1 Deliverables（Router Reachability & Durable Audit）

| 项 | 内容 |
|---|---|
| 生产链 | 组合根请求 `'router'` ⇒ `router_decisions` 真实存在（17 列校验 + opt-in 反证）；链清单单点维护于 `tests/shared/expected-chains.ts`，三条历史边界测试改为引用它 |
| Durable audit | 六个 `router.*` 事件经 `defineEvent` + `database.events.append` 落库；payload 12 字段白名单（测试逐键断言，无 request/prompt/secret） |
| 事务语义 | **非原子**：decision 先 → event 后（成功与 NO_ELIGIBLE 两条路径同序）；`reconcileRouterAudit()` + `repairPayloadOf()` 为对账工具，**生产启动接线待 10B.2**（事件存储暂无按类型查询） |
| IPC | `router.recommend` / `router.override.request` / `router.override.confirm`；`CLIENT_FORBIDDEN_ROUTER_KEYS` 拒绝九类客户端字段；应用层派生 view/候选/context；只返回 `ModelRecommendation` |
| rankingContext | 真实 Provider Registry health（unknown 0.25，禁止默认 healthy）；historical/benchmark 无源则不装配（不伪造） |
| Revision | `registryRevisionOf(records)`：内容绑定、无时钟/随机（同内容同 revision、内容变则变） |
| 持久化 | `DurableDatabase.routerDecisions`（仅 router 链存在时创建）；top-20 评估 / 20 拒绝 + `truncated`；`decision_id` 冲突显式 `PERSISTENCE_FAILED` |
| 重启可追溯 | 真实 SQLite：recommend → decision + events → close → reopen → 读回 selectedModelKey/decision/reasonCodes/evaluations/provenance/traceId，事件仍在 |
| 测试 | `tests/sprint10b-1/`：链与表 3 条 + A–AP 21 条；全仓 **92 文件 / 914 用例** |
| 评审修复（FAIL → 已修） | BLOCKER：组合根未把 `audit` 传给应用服务 ⇒ override 的两个事件从不落库（已接线，并把 `audit` 改为**必填**、移除 `deps.audit?.` 静默吞）；HIGH：文档声称"启动对账已启用"但 `reconcileRouterAudit` 无生产调用者（已改为如实表述 + 列入 10B.2）；HIGH：测试自建 emitter 导致组合根接线可被删除而测试仍绿（新增 **组合根接线断言** + **真实 SQLite 重复 decision_id 拒绝**测试）；MEDIUM：NO_ELIGIBLE 路径事件先于落库（已改为与成功路径同序）；MEDIUM：`effectiveBenchmarkWeight` 旧公式残留（**已加 DEPRECATED 标注** + ADR §28.2/权重表改为 `benchmarkAdjustment`，禁止再折叠权重） |
| 本轮发现的真实缺陷 | A–AP 套件抓到生产级 SQL 缺陷：`--` 注释吃掉 INSERT 收尾括号（`near ")" syntax error`），修复后持久化/重启全绿 |

## Sprint 10B.2 Deliverables（Router Reachability E2E & Startup Reconciliation）

| 项 | 内容 |
|---|---|
| 行为级 E2E | 真实组件 + 真实 SQLite：recommend/override → 决策落库 + 六个事件落库（直接查 `router_decisions` 与 `events`，不靠 mock/grep） |
| 启动对账 | 组合根启动调用 `reconcileAndRepairRouterAudit(...)`：读最近 500 决策 + 已审计 requestId → 计算 gap → 以**同一事件类型**补发并打标 `reconciled: true` / `repairReason: MISSING_RECOMMENDATION_EVENT` |
| 幂等 | 三次启动测试：第 1 次 repaired=1、第 2/3 次 repaired=0；补发事件只存在 1 条 |
| 计数语义 | `totalCandidateCount`（进入 Router 的候选）+ `eligibleCandidateCount`（硬过滤后）+ `storedEvaluationCount`/`truncated`；NO_ELIGIBLE 不再显示 total=0 |
| 健康新鲜度 | `providerHealthObservedAt` + 5 分钟窗口：过期观测降级 `unknown`（0.25），禁止把启动快照当实时健康 |
| Scope 语义 | `workflowId`/`runId`/`stageId` 解析为**上下文 id**；policy scope 仅 `COMPANY`/`WORKFLOW`/`ROLE`/`TASK`；WORKFLOW 策略可达（有测试） |
| IPC | 删除读取被禁字段名的死代码，forbidden-key 只有**一个**校验入口 |
| 事务 | 仍为**非原子**：decision → event，崩溃窗口由启动对账恢复；不得声称 ACID |
| 测试 | `tests/sprint10b-2/reachability-e2e.test.ts`（13 条）；全仓 **93 文件 / 927 用例** |
| 评审修复（HIGH + 3 MEDIUM + LOW → 已修） | **HIGH**：对账只把 `router.recommendation_created` 视为已审计，而 NO_ELIGIBLE 决策只发 `router.no_candidate` ⇒ 每次无候选都被误判为"审计缺失"并**伪造补发事件**（审计污染）。修复：引入 `ROUTER_TERMINAL_AUDIT_EVENT_TYPES`（两种终态事件都算已审计），并新增回归测试"no-candidate 决策不是 false gap / 不产生伪造事件"。MEDIUM：E2E 补 **blocked override 拒绝且无 `override_confirmed` 行**；`MODEL_ROUTER.md` 对账行改为"已接线"；provider health 改为**每次推荐前重新观测**（不再 5 分钟后永久 unknown）。LOW：补发事件改用**决策真实值**（selectionMode/candidateCount/rejectedCount），并导出 `ROUTER_AUDIT_REPAIR_KEYS`。 |

## Sprint 11 Deliverables（Structured Handoff — CLOSED）

| 项 | 内容 |
|---|---|
| Contract | `packages/core/src/domain/handoff.ts`：`HandoffPacket`（33 字段）+ `HandoffRef`（artifact/decision/validation/execution）+ 必填/证据门 + 安全校验 |
| State machine | 六态独立状态机（`DRAFT/READY/ACCEPTED/REJECTED/SUPERSEDED/CANCELLED`），非法迁移 `CONFLICT`；与 L1/L2/L3/Execution/Invocation 五套状态机**互不混用** |
| Versioning | `handoffVersion` + `supersedes = "<id>@v<n>"`；终态**内容不可改写**（服务层 `CONFLICT` + 存储层条件 UPDATE 双保险）；仅 `ACCEPTED/REJECTED → SUPERSEDED` 允许（只改 status） |
| Permissions | `handoff.create/read/accept/reject`；**accept 必须持 toRoleId**，否则 `PERMISSION_DENIED` + `WRONG_TARGET_ROLE`；创建者不能代收 |
| Service | `createHandoffService()`：createDraft/ready/accept/reject/cancel/supersede/get/versions/listForTargetRole；审计**必填**（无 logger-only） |
| Persistence | 迁移链 `handoff`：`handoffs`（PK `(handoff_id, version)`）+ `handoff_refs`；`createSqliteHandoffStore`（create/update/get/listVersions/listForTargetRole/listRecent）；版本冲突 `ALREADY_EXISTS` |
| Durable audit | 六事件 `handoff.created/ready/accepted/rejected/superseded/cancelled` 经 `defineEvent` + `events.append` 落库；payload 12 项白名单（含 `actorId`，无 summary/context/secret） |
| Runtime integration | 只经 `handoffContextViewIfAccepted()` + `serializeHandoffContextView()` → `AgentContext.previousHandoff`；**仅 ACCEPTED**；Runtime 不决定 next role/model/tool，也不 accept/reject/supersede |
| Restart | READY → close → reopen 仍 READY；accept → close → reopen 仍 ACCEPTED；**不自动** accept/生成 v2/生成下一 Handoff/启动 Agent/推进 Workflow |
| E2E | ① Developer → Reviewer（含 `previousHandoff` 有界投影）② reject v1 → supersede v2 → accept v2（v1 历史与内容不变） |
| A–AP tests | `tests/sprint11/handoff.test.ts`（16 条）+ `tests/sprint11/production-wiring.test.ts`（8 条）；Sprint 11 收口时为 **95 文件 / 951 用例**（当前 Sprint 12 closeout 为 97/972） |
| 本轮发现并修复的缺陷 | 存储层原先拒绝 `REJECTED/ACCEPTED → SUPERSEDED`（冻结状态机中的合法迁移）→ 改为"内容列永不写入 + 仅放行该终态→终态迁移" |

**关闭状态**：tag `sprint-11.0.0` 已创建，peeled commit =
`2cd040359ff0a6d7e5498bc62aa12cebec112891`；Independent Review 为 PASS WITH CONDITIONS，
BLOCKER 0 / HIGH 0 / mandatory MEDIUM 0。

**当前入口**：Sprint 12 已完成独立只读复核、收口与标记；不得提前进入 Sprint 13+，不得重开 Router/Handoff 主线。

## Sprint 12 Deliverables（Organizational Memory + Decision — CLOSED）

| 项 | 内容 |
|---|---|
| Core contracts | Company/Workflow/Role/Task scope；版本化 Memory 与 Decision 生命周期；确定性 scope shadowing、conflict、历史与过期边界 |
| Durable persistence | SQLite `memory` migration chain；Memory/Decision stores；UnitOfWork 原子 supersede；文件库 close/reopen 历史保持 |
| Provenance / trust | USER → ASSERTED；HANDOFF/DECISION/WORKFLOW 仅由组合根 durable verifier 产生 VERIFIED；SYSTEM 与客户端 trust 字段拒绝 |
| Runtime projection | 有界 Memory/Decision projection 接入 AgentContext；不调用 Router、不推进 Workflow、不启动 Agent |
| Audit | `memory.*` / `decision.*` 事件使用白名单元数据，不写正文；失败事务不产生半条 audit |
| Coverage | `docs/SPRINT12_COVERAGE_MATRIX.md` A–AZ 全部 PASS；`tests/sprint12/closeout-e2e.test.ts` 覆盖重启、原子性、provenance、投影、审计 |
| Quality gate | `pnpm check` 5× PASS；`pnpm test` 97 files / 972 tests；`pnpm test:scripts` 23/23 |

**Sprint 12 状态**：CLOSED；独立只读复核与门禁均通过，已创建 `sprint-12.0.0`；不得创建或移动既有 Sprint tag。

## Sprint 13 Deliverables（Artifact + Validation — CLOSED）

| 项 | 内容 |
|---|---|
| 架构冻结（13A） | `docs/sprint13/` 六份契约 + `docs/spec/S13_ARTIFACT_VALIDATION_CANONICAL_REQUIREMENTS.md`；ADR-0015/0016 Accepted，corrective ADR-0017/0018/0019/0020 Accepted |
| Artifact | Option A 不可变；artifactId≠contentHash≠contentRef；SQLite `artifact` 链（0001/0002）+ filesystem CAS（`userData/artifacts`，hard-link no-clobber，reparse 拒绝）；ArtifactService 三级幂等（ledger→permanent row→create）+ 全路径授权 |
| Validation | Sprint 1 契约复用 + `targetRef`（ADR-0017）；ValidationService（one command→one target→N validators）；Validator 由 Sprint 9 Registry capability 门受控解析执行；WARNING=fail+blocking:false |
| Tool 溯源 | durable replay output（tools/0004，ADR-0018）+ tool_version 溯源（tools/0005，ADR-0019；legacy null 永不回填，WAITING null 版本审批 fail closed） |
| 质量门 | EvidenceGuard + 引擎 `validationGate`（ADR-0020：run-pinned stage validatorIds=blocking-required，latest durable batch wins，caller verdict 字段结构性不可读） |
| 引用完整性 | resolve-all-before-write 注入 Agent/Tool/Handoff/Decision（run 锚 fail-closed）；Memory ARTIFACT/VALIDATION provenance（identity-only）激活 |
| 启动序 | quiescent startup CAS reconciliation（detect/report only，PATH 2 裁定）；fatal → 关库 fail startup closed；之后才暴露 window/IPC |
| 组合边界 | `artifact-stack.ts`（electron-free 组合模块）；Sprint 13 服务 = main-process 内部能力，**无 renderer IPC operation**（IPC boundary corrective）；AUTHORITIES +4（read 两项为 reserved vocabulary，无执行点） |
| Coverage | `tests/sprint13/` 十套（112 files / 1224 cases 全绿的一部分）；组合级 `composition-wiring.test.ts` 18 用例（startup happy/fatal/orphan、证据门、run-pinned 策略、真实授权、IPC boundary lock） |
| Quality gate | `pnpm check` 5× PASS；vitest 112 files / 1224 tests；`pnpm test:scripts` 23/23；空库 12 链迁移验证通过 |

**Sprint 13 状态**：CLOSED；收口记录 `docs/SPRINT13_CLOSEOUT.md`（含已知限制与延后工作）；
tag `sprint-13.0.0` 指向最终 closeout HEAD；下一 Sprint 为 Sprint 14（Recovery），未经批准不得开工。

## Sprint 14 Deliverables（Recovery — CLOSED）

| 项 | 内容 |
|---|---|
| 架构冻结（T14-01） | ADR-0021（Startup Recovery Orchestration）/ ADR-0022（Dependency-Failure）/ ADR-0023（Recovery Path Scope）Accepted + `docs/sprint14/` 契约三份 |
| 启动恢复编排（T14-02） | `packages/engine/src/recovery/startup-recovery.ts`（组合 recoverInterrupted/recoverInvocations/engine.recover + CRASHABLE_STATES 权威集；agent→tool→run；并发 single-flight + 顺序重扫 + 实例内 run memo；SAFETY FAILURE=fail closed）；`main.ts` 启动序 = DB→CAS reconcile→composeCoreServices→recovery→IPC/window |
| Crash E2E（T14-03） | 真实 SQLite 重开+全新对象图：3-stage 崩溃→恢复→resumePoint→显式续行；已完成 Stage 零重跑；六态 crashable 矩阵；RECOVERING/WAITING/PAUSED/CAS-fatal/二次重启语义全锁定 |
| 依赖故障（T14-04） | API Error/Quota：durable FAILED + provider.failed/agent.execution_failed 审计；启动零 provider；显式续行同 Run/Task；零自动/后台重试（recon：Agent runtime 无 in-attempt retry） |
| Tool 故障（T14-05） | STARTED→INTERRUPTED（启动 adapter=0）→人工 retryInvocation=新 attempt（lineage/独立幂等键/旧行不可变）；FAILED/WAITING/COMPLETED 一律拒；ADR-0018 replay 跨重启 |
| 边界 | 零新表列迁移、零新 IPC、零新事件、零 renderer 变更、AUTHORITIES 零新增、零依赖变更 |
| Coverage | `tests/sprint14/` 四套件 33 用例（组合级 116 文件/1258 用例全绿的组成部分） |
| Quality gate | `pnpm check` 5×PASS；`pnpm test:scripts` 23/23；空库 12 链 + Recovery 栈验证；全部 touched 文件 UTF-8/0 U+FFFD |

**Sprint 14 状态**：CLOSED；已知限制（外部副作用 exactly-once 不可证明等）与延后工作见
`docs/SPRINT14_CLOSEOUT.md`；tag `sprint-14.0.0` 指向最终 closeout HEAD；下一 Sprint 为
Sprint 15（Industry Pack Framework），未经批准不得开工。

## Sprint 15 Deliverables（Industry Pack Framework — CLOSED）

| 项 | 内容 |
|---|---|
| 架构冻结（T15-01） | ADR-0024（Industry Pack Domain Model）/ ADR-0025（版本与安装生命周期）/ ADR-0026（依赖与冲突）/ ADR-0027（溯源与 Run Pinning）Accepted + `docs/sprint15/` 契约三份 |
| 契约（T15-02） | `packages/core/src/registry/pack-manifest.ts`（canonical 语义权威：九类声明、`dependsOn` 精确版本、命名空间、严格校验、forbidden 字段拒绝、JSON-safe Generic Template）+ `domain/pack.ts`（PackVersion/PackInstallation/PackContentRef）+ contracts zod 投影（legacy alias 归一化）；`pack.manage` 入 AUTHORITIES（vocabulary-only）；fingerprint = qualified `sha256:<64hex>` |
| 持久化（T15-03） | `migrations/pack/0001_pack_persistence.sql`（三表 + CHECK + partial UNIQUE one-enabled + creation 永久身份）+ `core/src/ports/pack.ts` 三端口 + `sqlite-pack-stores.ts`（INSERT-only、fail-closed 读）+ pack chain（12→13） |
| PackService（T15-04） | `packages/engine/src/pack/pack-service.ts`：install/enable/disable/upgrade；冻结序管道（authorize → canonical → 永久身份 → 依赖闭包 → preflight → 单 UoW 物化/refs/事件）；物化经既有 authorization/lifecycle 服务（零 raw SQL） |
| Disable 守卫（T15-04 corrective） | Core 端口 `PackAvailabilityPolicy` + `pack-availability.ts`；any-live-owner + 公司域；守卫落在 `AuthorizationService.assign` 与 lifecycle 五个 new-use 入口（saveDraftGraph/publish/publishRevision/fork/createRun）；历史读与既有 Run 永不拦截 |
| Run Pinning（T15-05） | Core 端口 `PackRunProvenancePolicy` + `run-pack-provenance.ts`；`createRun` 写阶段前由 live owners + 传递 REQUIRED exact 闭包解析；`CreateRunInput.packVersions` **移除**（可信导出）；packless ⇒ `{}`；同 packId 两版本 ⇒ CONFLICT |
| 共享 provenance（T15-05） | `pack-provenance.ts`：`findPackOwnersOfMaterializedEntity` + `resolveExactDependencyClosure`（T15-04 提取，PackService 与 Run pinning 共用，无第二套 resolver） |
| 生产组合 | `main.ts` quiescent startup 以同一批 pack stores 构造 availability policy 与 run provenance resolver 并注入 authz/lifecycle；PackService 为 trusted application service（无 Pack IPC / renderer / 自动安装） |
| E2E（T15-06） | `tests/sprint15/industry-pack-framework-e2e.test.ts` 26 项：Scenario A 全链安装九类 / B 安全失败零写入 / C disable+re-enable / D upgrade+runs / E restart+recovery+evidence+corrupt 区分 / F legacy+结构锁；零 production 变更 |
| 边界 | 一个新迁移（pack/0001）、零新 IPC、零 renderer 变更、AUTHORITIES 仅 +`pack.manage`、零 package/lock 变更、零动态代码/loader/marketplace、零 delete API |
| Coverage | `tests/sprint15/` 三套件 83 用例（34 + 23 + 26）+ persistence 25 + core/contracts manifest；组合级 122 文件/1387 用例全绿 |
| Quality gate | `pnpm check` 5×PASS；`pnpm test:scripts` 23/23；UTF-8/0 U+FFFD/0 NUL；tag `sprint-15.0.0` 指向最终 closeout HEAD（本地，未 push） |

**Sprint 15 状态**：CLOSED；已知限制（无 marketplace / 无可执行 Pack / 无继承覆盖 / 无 semver range /
无 optional 依赖 / 无 hard-delete uninstall / 无 Pack IPC 与 renderer / 无 automatic selection /
Generic Template 无 runtime engine / CommandLedger 有界）与延后工作见 `docs/SPRINT15_CLOSEOUT.md`；
下一 Sprint 为 Sprint 16（DevCompany Pack），未经批准不得开工。

## Sprint 16 Deliverables（DevCompany Pack — CLOSED）

| 项 | 内容 |
|---|---|
| 产品合同（T16-01） | `docs/sprint16/S16_DEVCOMPANY_PRODUCT_CONTRACT.md`：packId `dev-company`@`1.0.0`（name `DevCompany`，codename CodeFleet 非 manifest 字段）、五角色 logical keys 与最小权限 authorities（BOSS-FROZEN DERIVATION，43 项既有 authority 内）、`dev-company:delivery-cycle` 五阶段链、五 prompt 合同、QA 真实证据规则、六 tool requirements（Sprint 17 身份）、validator/artifact/risk 声明、CapabilityRules/GenericTemplates 空类裁定、安装入口裁定（无自动安装/无 IPC/无 UI）、model policy 为 out-of-manifest 产品绑定策略 |
| Package + manifest（T16-02） | `packs/dev-company/`（`@companyos/pack-dev-company`，private、inert readonly data、唯一内部依赖 `@companyos/core: workspace:*`）；`DEVCOMPANY_MANIFEST`（`as const satisfies PackManifest` + contracts canonical parser + Core 语义校验器）；九类 24 项声明（5/1/5/6/1/5/1/0/0）；workspace 接线（vitest/tsconfig/build reference/lockfile importer，零外部依赖） |
| 产品内容（T16-03） | 五角色 authority 精确集合、workflow graph 保真（stage/role/validatorIds/riskLevel/approval/edges）、五 prompt 职责覆盖、QA 禁 LLM 自证、六 tool requirements、validator、五 artifact kinds、risk rule；30 项测试 |
| 边界/隔离/安全（T16-04） | 依赖方向单向（generic 平台零反向依赖）、行业词零泄漏（既有 boundary gate 不放宽）、零特殊路径、源码 inert、无 vendor/凭据、workspace 完整、无 generated artifacts；22 项测试 |
| 框架集成（T16-05） | 真实 PackService 成功安装 → 24 refs（6 非空/18 null）→ 5 Role + workflow 物化、零自动分配 → 真实 Run → `packVersions = {dev-company: 1.0.0}`；模型分离经**真实 Model Registry + Router** 证明（developer=`toolCalling`、reviewer=`reasoning`、不同 modelKey、写入 RunSnapshot.modelBindings、创建后不重解析）；disable/re-enable/真实重启；16+2 项测试 |
| 边界 | 零新 migration、零新 authority、零 Pack IPC、零 renderer、零桌面改动、零 Sprint17 runtime（受控 test tools 仅 fixture）、零 marketplace/loader、零自动安装；Core/Contracts/Engine 零 DevCompany 特判 |
| Quality gate | `pnpm check` 5×PASS；`pnpm test:scripts` 23/23；vitest **127 文件/1474 用例**（Sprint 15 基线 122/1387 → 只增不减）；UTF-8/0 U+FFFD/0 NUL |

**Sprint 16 状态**：CLOSED；已知限制（无 Repository/Terminal/Git 可执行 runtime、无可执行 QA validator
生产 tool、无 Pack UI/IPC、无 marketplace、无 Prompt/RiskRule runtime consumer、CTO 完整编排延后）与
延后工作见 `docs/SPRINT16_CLOSEOUT.md`；annotated checkpoint tag **`sprint-16`** 指向最终 closeout HEAD
（本地，未 push）。下一 Sprint 为 Sprint 17（Repository Runtime），未经批准不得开工。

## Independent Review Record（独立评审记录）

### Sprint 10A.0.3 Review（Cross-Model，独立上下文，只读）

- **verdict**：`PASS WITH CONDITIONS`｜**Blocker**：0｜**High**：0｜**Medium**：2（新增）｜**LOW**：7
- **ALLOW 10B**：`YES`（形式门槛满足）——我不采纳，因新增 MEDIUM-1 影响契约安全，改为先开 10A.0.4
- **未关闭项**：`evaluateManualSelection` 仍自行实现排除判定并与 `rulesExcludeCandidate` 出现分歧
  （`UNKNOWN_CAPABILITY` vs `CAPABILITY_MISSING`）；`assertDerivedPolicyView` 只校验 3/11 字段且缺字段时抛
  `TypeError`；digest 标量 `null`/`"null"` 同编码；文档称 frozen 但未 freeze；两处恒真/惰性测试；文档陈旧。

### Sprint 10A.0.4 Review（Cross-Model，独立上下文，只读）

- **verdict**：`PASS WITH CONDITIONS`｜**Blocker**：0｜**High**：1｜**Medium**：1｜**LOW**：7
- **ALLOW 10B**：`NO`
- **唯一 HIGH**：`SELECTION_EXCLUSION_TO_ROUTER_REASON` 把"范围外（allowedModels）"与"硬阻断"压成同一事实
  （`MODEL_BLOCKED_BY_POLICY` → `MODEL_BLOCKED`），与 Router 自己的 `NOT_IN_CANDIDATE_SET` 冲突 ⇒
  10B 采用该表会把可被显式选择豁免的范围排除误当硬阻断。
- **未关闭项**：测试 A 未跑 `applyHardFilters`（该有区分度处无效）；digest 尾段无异常防护；
  无 `Object.isFrozen` 断言；集合结构碰撞未测；`scopeId` 无类型校验、`NaN` 可通过数值校验；
  ADR 仍写"23 正面"、两处"Router 硬过滤全部经由统一规则"不实、`MODEL_ROUTER.md` 仍展示旧 10 键目录、
  handoff 字段数写错。

### Sprint 10A.0.5（本轮）修复对应关系

HIGH → §27.1 事实拆分（`NOT_IN_ALLOWED_RANGE`）；MEDIUM → 跨路径一致性测试改为**真实调用** `applyHardFilters`；
LOW → 整体 try/catch 安全边界、`Object.isFrozen` 运行时断言、集合/保序列表结构碰撞测试、`scopeId` 类型与
finite 数值校验、文档对账与两次评审记录回填。

### Sprint 10A.0.2 — Cross-Model Independent Review（第二次评审，独立上下文，只读）

**评审对象**：tag `sprint-10a.0.2`（HEAD `53faa3a8a2915574906a3c46c192697458da6689`）· 基线 `sprint-10a.0.1`。
**判定：`PASS WITH CONDITIONS`；无 BLOCKER；1 个 HIGH + 4 个 MEDIUM + 7 个 LOW。**
**结论：`ALLOW 10B: NO`**（不满足"无 High 且本轮 Medium 全部关闭"）。

**六项条件的复核结论（评审原文）**：HIGH-1 `CLOSED`（`model-router.ts:747-773`，`applyHardFilters:818` 先调用它，ADR §24.1）·
MEDIUM-1 `CLOSED`（`applyHardFilters:817` 返回 Result，入口 `:820-821` 校验，digest 覆盖 7 字段 `:634-637`）·
MEDIUM-2 `CLOSED`（旧目录仅存注释 `:220`，唯一目录 `:269`，未排序信号 `:223`，权重 `.25/.20/.15/.15/.10/.05/.10` 和=1）·
MEDIUM-3 `CLOSED`（`:180` 模式声明并 `:801/:912` 暴露，`LATENCY_LIMIT_EXCEEDED` = `FUTURE` `:148`，v1 无 latency 淘汰分支）·
MEDIUM-4 `CLOSED`（`validateRecommendation:1023-1077`，六条规则齐备，非法组合有测试）·
MEDIUM-5 `CLOSED`（`manualOutcome:998-1003`、`applyHumanOverride:1104-1109` 均读派生视图）。LOW-2 与 §八 亦 `CLOSED`。

**未关闭项（下一轮必须处理）**：

| 级别 | 发现 | 证据 | 最小改法 |
|---|---|---|---|
| **HIGH** | **§九 未真正落实**：唯一生产入口仍用时钟生成 `snapshotVersion` 且未传 `generatedAt`；ADR §24.8 与 handoff 的"引擎侧不再用 `nowIso()`"/"`policyId@content-digest`"**与代码不符**；且 `snapshotVersion` 不是 digest 输入 ⇒ 既非内容绑定也未被防篡改覆盖，相同输入产出不同视图（违反端口确定性契约） | `packages/engine/src/registry/selection-policy.ts:270`（`snapshotVersion: \`${policy?.id ?? 'no-policy'}@${nowIso()}\``；该文件不在本次 diff 内）；`model-router.ts:634-637`；`ports/model-router.ts:23` | 服务改为 `snapshotVersion = \`${policyId}@${view.digest}\``（先派生一次得到 digest，或让 `deriveRouterPolicyView` 接受可选 `contentDigest`），时间戳只写 `generatedAt: nowIso()`；把 `snapshotVersion`（或至少 policy identity + mode + fallback）纳入 digest；补确定性测试（同 policy 两次派生 → 同一视图） |
| MEDIUM | digest **对顺序不敏感**：`viewDigest` 对所有列表排序（`:598`），而视图保留 `preferredModels` 顺序（`:612`）⇒ 反转 `preferredModels` 能通过防篡改校验，尽管其位置权重占 **0.25** | `model-router.ts:598/612/642-663` | `preferredModels` 不排序（其余列表可排序），或对 `preferredModels` 使用保序的 join |
| MEDIUM | digest **未覆盖 `source`**：`source.mode` / `source.fallback` / `policyId` / `snapshotVersion` 不在 digest（`:634-637`，校验侧 `:650-653`）⇒ 把 `source.mode` 从 MANUAL 改成 AUTO、或改 `fallback` 能**绕过 HIGH-1 的 mode 门** | 同上 | 将 `source.mode`、`source.fallback`、`policyId`、`snapshotVersion` 纳入 digest |
| MEDIUM | `RouterPolicyView` **缺少顶层 `allowFallback`/`scopeType`**（`:561-575`），而 `SelectionRules` 声明它们可选（`model-selection-policy.ts:251-260`）⇒ 视图路径的判定**静默**使用 `'NEVER'` 兜底与 `undefined` scope（`:326`/`:304`） | 两文件同上 | 在视图顶层补 `allowFallback`（= `source.fallback`）与 `scopeType`，或让 `SelectionRules` 显式接受 `source` 结构 |
| MEDIUM | `NO_ELIGIBLE_MODEL` 的校验用 **OR**（`:1043`）：只要 `candidateEvaluations` 非空就允许 **零** 拒绝记录 ⇒ "有候选但未选出"也能通过不变式 | `model-router.ts:1043` | 改为 AND（必须同时具备拒绝记录与评估记录），或要求 `summary` |
| LOW | `HardFilterOutcome.candidates` 同时暴露**未 brand 的数组**（`:794`）⇒ LOW-2 可绕过；`hybridCandidates`/`describeAutoPolicy`（`model-selection-policy.ts:373-418`）仍是第二个策略解释器（有自己的排除词表、忽略 `maxLatency`）；`SelectionRules` 未从 index 导出；`V1_NOT_RANKED_MARKER`（`:229`）未挂到任何条目；`RANKING_HARD_CONSTRAINTS_LEGACY`（`:379`）为死代码；handoff 写"37 个码"实为 **38**；`contract-hardening.test.ts:346-351` 为恒真测试（从未断言端口要求调用校验）、`:251` 亦恒真 | 各文件 | 删除 `candidates` 或改为只暴露 brand；把 hybrid/auto 视图也切到派生视图；导出 `SelectionRules`；把 marker 挂到 `V1_NOT_RANKED_SIGNALS` 条目上；删除死代码；改正计数；补两条有区分度的断言（端口契约 + ADR/代码一致性） |

**下一步建议**：开 **Sprint 10A.0.3（Router Version & Digest Hardening）**：修 HIGH + 4 个 MEDIUM + 关键 LOW，
补确定性/顺序敏感/来源覆盖测试，然后再跑一次独立评审；通过前**不得**开 10B。

| 编号 | 级别 | 问题 | 处理 |
|---|---|---|---|
| BLOCKER-1 | 高 | roadmap 在提交前声称 Sprint 1 已完成并引用不存在的 tag/哈希；handoff 未更新 | 改为「先提交、后回填真实哈希」；本文件的 Commit 段在提交后回填 |
| BLOCKER-2 | 高 | `status:'pass'` 可无 exitCode 通过；`qualityGatePassed([])` 为 true（零证据即通过） | `pass` 必须有证据；空质量门 = 不通过；补测试 |
| HIGH-1 | 高 | `STATE_MACHINE.md` §9/§10/§11 仍用被取代的 8 态词表 | 全部按 L1 改写；新增「旧词表缺席」测试 |
| HIGH-2 | 高 | `PAUSE` 可从规划前状态出发，`RESUME` 一律进 `EXECUTING` → 可绕过规划/路由/审批门 | 暂停仅限执行期 8 态；恢复返回记录点 `resumePoint`；补测试 |
| HIGH-3 | 高 | Agent 红线靠厂商黑名单：泄露厂商名且不完备（`logical.mistral.default` 可过） | 改为闭集 slot 白名单，Core 不再出现任何厂商名 |
| MEDIUM-1..4 | 中 | 文档与代码不一致；死事件声明；审批无授权校验；测试计数口径 | 逐条修复（§4.3 显式枚举、事件双向断言、`run.approve` 授权、口径说明） |
| LOW/NIT | 低 | 端口裸 string id；Artifact 校验边界未写明；返工口径歧义；L2 大小写；pack 命名空间 | 逐条修复 |
| 复评 MEDIUM | 中 | 绑定 tier 段无约束 → `logical.reasoning.<product>` 可绕过红线 | 增加闭集 `LOGICAL_BINDING_VARIANTS`（default/cheap/balanced/strong）+ 负例测试 |
| 复评 LOW | 低 | 证据引用未校验空白；无效 `resumePoint` fail-open；`authorities` 自述来源未记载；§10.3 标签残留 | 证据必须可寻址（`artifact:` / `command:`）；无效恢复点抛 `ILLEGAL_TRANSITION`；ADR-0002 记载由外环从 `Role.authority` 解析；标签更正 |

### Sprint 2（Workflow Engine）独立评审

| 编号 | 级别 | 问题 | 处理 |
|---|---|---|---|
| HIGH | 高 | 审批副作用在转移守卫**之前**执行 → 非法/过期命令会留下孤儿 pending 审批，双向破坏 X-03 | `execute` 顺序改为「纯校验 → 审批副作用 → 持久化 → 追加事件」；补两条回归测试断言拒绝时 `approvals.snapshot()` 不变 |
| MEDIUM | 中 | 状态写入与事件追加非同一事务（`runs.put` / `events.append`） | 记入 ADR-0005 代价与 `WORKFLOW_ENGINE.md` §8：Sprint 3 用 `UnitOfWork` 收敛 |
| MEDIUM | 中 | 任务级转移不产事件（需求 ⑪ 缺口）；事件目录存在无人发射的条目 | 引擎新增 `task.state_changed` / `task.blocked` / `approval.*` 发射；Core 新增 `CORE_EVENT_EMITTERS` 唯一发射方表 + `event-emitters.test.ts` 全覆盖断言 |
| MEDIUM | 中 | `drive` 用类型断言伪造 `RunSnapshotRef` | 内部 `StageRequest` 收窄（不含 snapshot），端口 `advance()` 接受完整请求后收窄 |
| MEDIUM | 中 | handler 反向调用 `dispatch` 可能死锁 | 基于 `AsyncLocalStorage` 的重入守卫 → `CONFLICT/reentrant_dispatch`；契约写入 `handlers.ts` 与 ADR-0005；新增 `reentrancy.test.ts`（含"不得误伤真并发"负例） |
| LOW | 低 | `assertReasonConsistency` 生产死路径；审批查询单页扫描；per-run 映射无清理；事件缺失静默 | `dispatch` 现在调用该断言；审批查询改为分页；终态清理映射；转移规则缺失改为显式 `CONFLICT` 不变式错误 |

### Sprint 3（Persistence）独立评审

| 编号 | 级别 | 问题 | 处理 |
|---|---|---|---|
| HIGH | 高 | 阶段执行的 task 状态写 + `task.*` 事件不在任何事务内（只有 run 级命令在事务里） | `executeStage` 整体纳入 `unitOfWork.transaction`（内层 run 命令经 ALS 加入外层）；新增回归测试：事件写失败时 task 回到 `PENDING`、attempts 0、run 仍 `EXECUTING`、无 task 事件 |
| MEDIUM | 中 | `approvalByRun` 缓存在事务内改动，回滚后缓存指向不存在的审批，`GRANT` 永久 `NOT_FOUND` | 缓存只在 **COMMIT 之后**更新；`pendingApprovalId` 命中缓存时仍校验存储，不一致即自愈回退查库 |
| MEDIUM | 中 | `AGENTS.md` 在提交前声称 Sprint 3「已完成并验收」 | 改为「实现完成、待独立评审与提交」，提交后由本次回填提交改成「已完成并验收」 |
| MEDIUM | 中 | 未注入 `UnitOfWork` 时静默退化为无事务 | 引擎记 `logger.warn`；ADR-0006 记载「组合根必须注入」 |
| LOW | 低 | ledger `trim` 按调用方时钟 `recorded_at` 淘汰 | 改为按内部插入序 `rowid` 淘汰 |
| LOW | 低 | task 事件 `run_id` 为 NULL，整轮执行无法一次审计 | task 事件 payload 带 `runId` 并落库；新增 `readByRun` + `(run_id, global_position)` 索引 + 断言 |
| NIT | 低 | `db.ts` 的同步事务与 durable 事务并存易混用 | 注释写明「迁移专用、运行时用 UnitOfWork」 |

### Sprint 4（Workflow Lifecycle）独立评审

| 编号 | 级别 | 问题 | 处理 |
|---|---|---|---|
| MEDIUM | 中 | 版本事件 `aggregateType='WorkflowVersion'` 但 `aggregateId` 是模板 id → `readByAggregate('WorkflowVersion', versionId)` 查不到任何事件 | Core 三个版本事件改为按**版本 id** 聚合（模板 id 入 payload）；新增"按版本 id 审计"断言；O 测试按聚合键精确过滤 |
| MEDIUM | 中 | `snapshotOfRun` 声明返回 `RunSnapshot` 却返回 Promise（类型说谎） | 改为 `Promise<RunSnapshot \| null>`，并复用 store 的行映射，去掉 `as unknown as` |
| MEDIUM | 中 | 需求⑤⑦的 Review/Fork 映射未记录（首版无评审门、Fork 不在修订路径） | ADR-0007 §8 明确两条路径的映射与首版免审的理由 |
| MEDIUM | 中 | 服务无任何 authority 校验 | 新增 `authorize` 政策缝 + `LIFECYCLE_AUTHORITIES`（10 个授权点）+ 测试；缺口（未注入即 allow-all）记入 ADR-0007 §9 |
| MEDIUM | 中 | 既有 Bible `WORKFLOW_LIFECYCLE.md` 与本实现口径冲突（草案号、草案行去向） | Bible 顶部加"实现说明 + 已知差异"并指向 ADR-0007；裁定记录于本文件 |
| LOW | 低 | 双发布防护的因果描述不准（部分唯一索引 vs 事务串行 + 草案消费） | ADR-0007 §10 与 `LIFECYCLE_GOVERNANCE.md` §6 写准 |
| LOW | 低 | `createRunSnapshot` 的 `!immutable` 是死守卫 | 增加 `isDraftSemver` 真实守卫（保留原守卫以兼容既有测试） |
| NIT | 低 | `createRun` 用 `requireState(['published'], 'lock')` 消息误导；O 测试硬编码 forked 类型 | 改为显式状态拒绝（保留原错误码）；O 测试真正 fork 并按全量日志校验词表 |

## Next Sprint Entry Point（历史：Sprint 10 入口 — Model Router）

**用户裁定（不可谈判）**：
1. **开工前必须先写 Router ADR**，然后再写代码；
2. Router **不得破坏**既有 `MANUAL` / `AUTO` / `HYBRID` 语义：
   - **MANUAL**：用户指定模型 → **Router 不得覆盖**；
   - **HYBRID**：Router **只能在 policy 候选范围内**选（`allowedModels` / `allowedProviders` /
     `requiredCapabilities` / cost / latency）；
   - **AUTO**：Router **才可以完整自动选择**；
3. **Explicit User Choice 永远优先于 Router Recommendation**（ADR-0011 的冻结阶梯不变）；
4. Router 仍是**新的一层**：Agent Runtime / Tool Registry 的"不选模型 / 不选工具"边界**不变**。

**建议的 ADR 内容**：候选集来源（只用 Sprint 7.5 的 `hybridCandidates`/policy 数据）、
排序依据（能力/成本/延迟与不可解释风险的取舍）、失败与回退语义（`NEVER`/`ASK`/`AUTO_WITHIN_POLICY` 的落点）、
可解释性（每次选择必须能回答"为什么是它"）、与 benchmark 的关系（**benchmark 仍只是元数据**）、
以及"Router 不可用时 `AUTO` 必须继续返回 `MODEL_SELECTION_REQUIRED`"。

## Next Sprint Entry Point（Sprint 10 入口 — 旧记录，保留为历史）

**Sprint 10：尚未开始，等待用户批准。** Sprint 9 交付了工具契约、权限、风险门、双向 schema、幂等与一次受控轮。
候选方向（均不需要 Router / Planner）：

1. **真实 ToolDescriptor 进 PromptPlan**（Sprint 9 MEDIUM-2 的后续）：让 `descriptors()` 的
   description/parameters 真正进入模型请求，并补 PromptPlan 级测试；
2. **Validator / Risk 资产化**（P1）：把 MEDIUM 的 `requiresValidator` 从标志变成真资产；
3. **Artifact / Result 资产化**（P1）：`resultRef`/`artifactRefs` 仍是引用，需要真正的产物存储与版本；
4. **工具恢复与清理**：`tool_invocations` 的陈旧 `STARTED/WAITING_APPROVAL` 恢复扫描（Sprint 9 LOW 遗留）；
5. 若要 Router / 多步工具编排：第一步永远是**立 ADR + 用户明确解除禁止项**。

**Sprint 9 遗留（非阻塞，见上表 LOW/NIT）**：幂等查重分页与 UNIQUE 翻译、重放语义文档化、
HIGH 自批说明、工具 invocation 恢复、`tools.list` 截断、`IDEMPOTENT_REPLAY` 发射。

**仍然禁止**：Model Router、自动选模型、scoreModel、rankModels、bestModel、自动 fallback、多模型协作、
自动 Tool Planner、无限 Tool Loop、DevCompany、Coding Agent、AI 自动生成 Workflow、真实厂商 API、
真实生产 Tool、云端同步、多人协同。

## Next Sprint Entry Point（Sprint 9 入口 — 已满足，保留为历史记录）

**Sprint 9：尚未开始，等待用户批准。** Sprint 8 已把"执行一次明确绑定"跑通（MockProvider 端到端）。
候选方向（均**不需要** Router）：

1. **Tool Registry**（P1，与 Model Registry 同构：策展层 + 能力声明 + 启停 + 别名 + 权限 + 审计），
   与 Runtime 的 `tools` 声明对接（当前 Runtime 只转发声明，不执行工具）；
2. **Artifact / Result 资产化**（P1）：当前 `resultRef`/`artifactRefs` 只是引用，需要真正的产物存储与版本；
3. **Validation / Risk 资产化**（P1）：把执行结果接进质量门与审批门；
4. 若要 Router：第一步永远是**立 ADR + 用户明确解除禁止项**，而不是写代码。

**Sprint 8 遗留（非阻塞，见上表 LOW/NIT）**：`agent.read` 未执行；`run()` 不重新验证绑定；
恢复扫描分页；上下文聚合预算；Provider kind 词表对齐；`structuredKeys`/`tools` 形状校验。

**仍然禁止**：Model Router、自动选模型、scoreModel、rankModels、bestModel、自动 fallback、多模型协作、
Tool Registry 正式实现、DevCompany、Coding Agent、AI 自动生成 Workflow、真实厂商 API、云端同步、多人协同。

**开工前**：先跑一次 120 秒写入漂移采样（`docs/WORKSPACE_GOVERNANCE.md` §3），确认单一 Writer。

## Next Sprint Entry Point（Sprint 8 入口 — 已满足，保留为历史记录）

**Sprint 8：尚未开始，等待用户批准。** 用户已明确"下一步不要进入 Model Router"，
因此 Sprint 8 的候选是（按规划书 §五十八 的 P1，且都不需要 Router）：

1. **Tool Registry**（与 Model Registry 同构：工具策展层 + 能力声明 + 启停 + 别名 + 审计；风险最低）；
2. **Validation / Risk 资产化**（直接服务 Workflow 的质量门与审批门）；
3. 若要推进 Router/Agent Runtime：**第一步不是写代码**，而是立 Router ADR（评分口径、失败与回退语义、
   成本/延迟权重、可解释性、与 ModelSelectionPolicy 的边界）并取得用户明确解除禁止项。

**Sprint 7.1/7.5 遗留（非阻塞）**：
- 尚无 Router：`AUTO` / `HYBRID` 只保存与解释；`preferredModels` 只影响展示顺序；
- 无"同 Workflow 两角色必须不同模型"的强制校验（留给 Router ADR）；
- `maxCost` / `maxLatency` 只做准入判定，不做预算执行；
- `benchmark_results` 目前为空：真实跑分需要适配器（用户批准后）。

**仍然禁止**：自动选模型、模型评分路由、fallback、Model Router、真实 Agent Runtime、真实厂商 API 调用、
DevCompany、Coding Agent、多模型调度、AI 自动生成 Workflow、多人协同、云端同步。

**开工前**：先跑一次 120 秒写入漂移采样（`docs/WORKSPACE_GOVERNANCE.md` §3），确认单一 Writer。

## Open Risks（历史：Sprint 1 收口时点）

> 以下表格保留为历史风险记录，不代表 Sprint 12 开工前的 active risk 清单；当前非阻塞 LOW 与边界风险
> 见 `PROJECT_EXECUTION_HANDOFF_TO_CODEX.md` §8、§12。

| 风险 | 影响 | 缓解 |
|---|---|---|
| 曾有第二个 Agent 会话并行写同一工作区 | 验证结论可能对不上某一瞬间的树 | ADR-0004 + `AGENTS.md` §1.5 强制单一 Writer；每轮开工做漂移采样；Sprint 1 采样为 0 变化 |
| L2（`lifecycle/template.ts`）用裸 `string` id，L1 用品牌化 id | 边界转换处存在误用风险 | 显式转换缝 `asId<'WorkflowTemplateId'>()`；已在 `domain/workflow.ts` 注释与测试中固化 |
| 端口签名冻结后仍可能不够用 | Sprint 2 可能要改端口 | 只能走 Change Proposal + ADR 修订；`WorkflowEnginePort` 已在 ADR-0002 标注为前瞻性设计 |
| `node:sqlite` API 演进 | 升级 Node 可能破坏持久化层 | 替换面收敛在 `packages/persistence/src/db.ts` + 迁移执行器 |
| 文档与代码漂移 | 评审依据失真 | `docs/tests/*` 已把「文档齐备 / 链接可解析 / 优先级与状态口径一致」纳入 `pnpm check` |
| 覆盖率阈值未入门禁 | 回归可能未被测试捕获 | `vitest.config.ts` 已配置阈值；Sprint 3 起把 `--coverage` 纳入门禁 |
| 引擎的状态写入与事件追加**非原子** | 进程在两步之间崩溃可能出现"状态已写、事件未落" | ADR-0005 显式记录偏差；Sprint 3 用 `UnitOfWork` 收敛 |
| `StageHandler` 若反向调用 `dispatch` 会等待自身临界区 | 死锁（已用重入守卫转为 `CONFLICT`） | 契约写入 `handlers.ts`；`reentrancy.test.ts` 覆盖；handler 只返回结果 |

## Known Limitations（历史：Sprint 1 收口时点）

> 以下列表保留 Sprint 1 收口时的限制快照，不覆盖后续已关闭 Sprint 的真实交付；当前 Handoff 限制见
> `docs/HANDOFF.md` §15，当前 Router/Handoff LOW backlog 见 `PROJECT_EXECUTION_HANDOFF_TO_CODEX.md` §8。

1. **`pnpm dev` 无法启动窗口**：Electron 运行时二进制下载遇到 `ECONNRESET`；`allowBuilds.electron=false`
   显式声明。类型/构建/检查不受影响；恢复方式 `pnpm approve-builds` 或 `pnpm rebuild electron`。
2. **桌面壳无端到端冒烟**：安全基线由单测与代码审查覆盖，无真实窗口运行记录。
3. **生产 CSP 只在打包模式注入**：开发模式不注入，以便 Vite HMR。
4. **持久化仍是 JSON 文档表**：`entities(kind, id, doc, …)`；引擎当前使用内存实现
   （`createInMemoryEntityStore` / `createInMemoryEventStore`）；真实领域表（`workflow_runs`、
   `workflow_templates` 等，见 `docs/STATE_MACHINE.md` §10）属 Sprint 3。
5. **无事件总线实现**：`EventBus` 仅契约；`EventStorePort` 已有内存实现，SQLite 实现属 Sprint 3。
6. **无密钥存储实现**：`SecretResolver` 仅契约。
7. **执行者只有确定性 stub**：Sprint 2 的 `StageHandler` 全部是脚本化假执行器，**没有任何真实的
   模型或工具调用**；真实 Agent Runtime 属 P1（Sprint 8）。
8. **CI 仅静态断言**：工作流文件由 `docs/tests/ci-config.test.ts` 校验，未在真实 GitHub 上跑过。
9. **幂等账本在内存**：进程重启后同一 `commandId` 会重新执行（旧命令仍会因 revision 过期被拒）；
   Sprint 3 落库 `command_ledger`。
10. **事件目录中仍有 8 个条目尚未有发射方**（`stage.created`、`stage.state_changed`、`task.created`、
    `validation.recorded`、`artifact.created`、`company.created`、`role.created`、`agent.created`、
    `pack.installed`、`pack.disabled`）——它们已在 `CORE_EVENT_EMITTERS` 中标注归属 Sprint，
    由 `event-emitters.test.ts` 保证不会沉默漂移。

## Commit（提交）

- Sprint 0：`d44437f7f7772dc9266e65d6a8d1ba12cc464571`（tag `sprint-0.0.1`）+ `76d7bd7`（交接回填）。
- **Sprint 1：`e13379c219a1c9ebf5360b0587c0a914554b5a27`（tag `sprint-1.0.0`，44 个文件）**
  —— `feat(sprint-1): Core Domain, frozen 23-concept vocabulary and 11-port boundary`。
- 提交顺序遵循规划书 §六十六 STEP 8：**先提交、后回填本文件**（本段与 roadmap 的交付记录
  是在该提交之后写入的，因此其"已完成"表述成立）；本文件的这次更新自身是紧随其后的一个
  文档提交，不改变任何代码。
- 后续跟随提交（不影响 Sprint 1 基线）：`docs(handoff): record sprint-1.0.0 commit hash and
  independent review outcome`、以及按最终评审 NIT 修正 `run-state.ts` 恢复点注释的提交
  （Sprint 1 代码逻辑未变，`pnpm check` 仍为 Exit Code 0）。
- **Sprint 2：`b078eb08f20bd04f471538d23571cf6c8245fc39`（tag `sprint-2.0.0`，41 个文件）**
  —— `feat(sprint-2): deterministic workflow engine (command boundary, idempotency, revision,
  retry/pause/resume/approval/rework/branch)`；随后一个文档提交记录本段与 roadmap 的交付记录
  （同样遵循「先提交、后回填」）。
- **Sprint 3：`5f37c74a4a0df20856b2012843854eb3d842aa8a`（tag `sprint-3.0.0`，29 个文件）**
  —— `feat(sprint-3): durable persistence (unit of work, SQLite stores, event ordering,
  cross-restart idempotency)`；随后一个记录提交更新本文件、roadmap 与 `AGENTS.md` 的阶段状态。
- **Sprint 4：`dbbf2e4d2ef598dd0cb7b7492477a016b8363cf9`（tag `sprint-4.0.0`，19 个文件）**
  —— `feat(sprint-4): workflow lifecycle governance (...)`；随后一个修复提交（评审 5 MEDIUM + LOW/NIT）与
  一个记录提交。
- **Sprint 5：主提交 `90ef6181aa40777694def20e907f7573fa6480e9`（21 个文件）**
  —— `feat(sprint-5): workflow designer (...)`；评审修复提交 **`1caaba4e1ac3c8dc304b92660e0e5b0b3673378b`**
  （**tag `sprint-5.0.0`**）；记录提交 `10e1866`。
- **Sprint 6：主提交 `6bb777b5ef24ea8be30cb5e17803ce572b8e4eec`（23 个文件，tag `sprint-6.0.0`）**
  —— `feat(sprint-6): vendor-neutral provider layer (...)`；评审修复提交
  **`583b99890ada97d8073fe79bcc64f111e0616cba`**；记录提交 `9c71f86`。
- **Sprint 7：主提交 `5dfa91e3061389008169df18354ad866d2db3b4a`（26 个文件，tag `sprint-7.0.0`）**
  —— `feat(sprint-7): model registry (...)`；记录提交 `d0d51b2`。
- **Sprint 7.1 + 7.5：主提交 `c4dcb5225241055bf873654b8a7e03b0cb594d14`**（tag `sprint-7.1.0` 与 `sprint-7.5.0`
  在评审前创建，均指向该提交；评审发现 1 HIGH + 4 MEDIUM）；记录回填 `45028da`。
- **Closeout-7.5（评审修复）**：`1 个 HIGH（selection 链未启用）+ 4 个 MEDIUM + LOW/flake 加固`与 handoff
  记录同批提交，**tag `sprint-7.5.1` 指向该 Closeout 提交**（依约定：tag 表示"通过评审并修完条件后的状态"）；
  其后有一次**记录修正提交**（`docs/tests/handoff.test.ts` 要求本文件的哈希字段为真实 40 位十六进制值），
  故 `sprint-7.5.1` 最终指向修正提交 `f9abf7eb4a371930798e269254550cec9f6e6424` 之后的状态。
- **Sprint 8：主提交 `a6394954d217fab7ba0964b54d56b9244887c473`**（23 个文件，评审前状态）。
- **Sprint 8 Closeout（评审 3 个 MEDIUM 修复）**：与本次 handoff 记录同批提交——
  来源诚实化（去掉伪造的 `'ROUTER'`）、scope 推导（策略门不可绕过）、`INTERRUPTED` 独立 kind（非可重试）；
  **tag `sprint-8.0.0` 已重指到该修复后的状态**（用 `git rev-list -n 1 sprint-8.0.0` 取哈希）。
- **Sprint 9：主提交 `0ae169d3973a1a28f06d4fda359c7d6e53c521ca`**（tag `sprint-9.0.0`，评审前状态）；
  评审发现 1 HIGH + 3 MEDIUM 后修复，修复状态由 **tag `sprint-9.0.1`** 指向（`git rev-list -n 1 sprint-9.0.1`）。
- **Sprint 9.1：主提交 `4ad2b937c2f2019b2f60cd230aabbfaa49063e48`**（tag `sprint-9.1.0`，评审前状态）；
  评审的 3 MEDIUM + 4 LOW 由 **tag `sprint-9.1.1`** 指向的提交收口（`git rev-list -n 1 sprint-9.1.1`）。
- **Sprint 9.1.2：主提交 `73225344bccd87703b74c807d3cbccc4294fef87`**（评审 `PASS`，无 Blocker/High）；
  NIT/文档收尾由 **tag `sprint-9.1.2`** 指向的提交收口（`git rev-list -n 1 sprint-9.1.2`）。
- **Sprint 10A / 10B / 10B.1 / 10B.2**：均已关闭；最终 Router 主线 tag
  `sprint-10b.2.0`（Router 主线 CLOSED，冻结语义不得重开）。
- **Sprint 11：tag `sprint-11.0.0`**（annotated tag；peeled commit
  `2cd040359ff0a6d7e5498bc62aa12cebec112891`）—— Structured Handoff CLOSED；随后纯文档交接提交
  `0fcb5af62ade9918b91a779bd023f202371f0c14` 为 Docs Truth Reconciliation 开始前的基线 HEAD。
- **Sprint 13：T01–T12 共 27 个提交（`775b78f` 冻结后起，逐 Task 独立 commit + corrective，未 amend；
  完整清单见 `docs/SPRINT13_CLOSEOUT.md`）**，以两个 closeout 提交收口（`chore: close sprint 13` +
  `fix: reconcile sprint 13 closeout status guards`，后者为 §39 proven defect 修复：
  状态真相守卫从 post-Sprint-12 更新为 post-Sprint-13，AGENTS.md 状态段同步）；
  **tag `sprint-13.0.0`**（annotated，message 沿 Sprint 12 惯例）指向最终 closeout HEAD
  （`git rev-list -n 1 sprint-13.0.0`）；未 push（无 remote）。
- **Sprint 14：T14-01~T14-06 共 7 个提交（`857b52a` 冻结 → `ce94abc` 编排器 → `36d988d` Crash
  E2E → `35a2a14` 依赖故障 → `69631c4` Tool E2E → `7c8deeb` contract 补记 → closeout 提交
  `chore: close sprint 14`，后者含状态真相守卫 post-Sprint-14 更新）**；**tag `sprint-14.0.0`**
  （annotated，message 沿惯例）指向最终 closeout HEAD（`git rev-list -n 1 sprint-14.0.0`）；未 push。
- 记录值：`73225344bccd87703b74c807d3cbccc4294fef87`（Sprint 9.1.2 主提交）
- Sprint 7.1 + 7.5 主提交：`c4dcb5225241055bf873654b8a7e03b0cb594d14`
