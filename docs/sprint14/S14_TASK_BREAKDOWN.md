# Sprint 14 Task Breakdown（Task-14-01 冻结产物）

> 状态：**FROZEN**（Accepted：`TASK-14-01 APPROVED` 指令 §35/§36，2026-09-26）。
> 配套：`S14_RECOVERY_CONTRACT.md` · `S14_TEST_STRATEGY.md` · ADR-0021/0022/0023。
> Sprint 14 Mission 不变（roadmap 冻结原文）：失败是流程的一部分；系统能从中断处继续。
> 纪律：逐 Task 独立 commit → 完成即停 → 等 Boss review + `TASK-14-0X APPROVED`。

## 依赖图（§36 冻结）

```text
T14-01
   ↓
T14-02
   ↓
T14-03 ─┐
T14-04 ─┼→ T14-06
T14-05 ─┘
```

T14-03 / 04 / 05 实现阶段可部分并行，但全部依赖架构冻结（T14-01）与编排器（T14-02）。

### Task-14-01 Recovery Architecture Freeze（**已完成：本 commit；ADR-0021/0022/0023 Accepted**）
- **Goal**：冻结启动恢复编排、依赖故障策略、恢复路径范围；产出本文件 + Recovery Contract + Test Strategy。
- **Scope**：docs/ADR only；零 production code / 零 migration / 零测试行为变更 / 零新 IPC。

### Task-14-02 Quiescent Startup Recovery Orchestrator（**已完成：`packages/engine/src/recovery/startup-recovery.ts`（electron/fs/SQLite-free，组合既有 recover* 原语 + CRASHABLE_STATES 权威集）；`main.ts` 组合抽取 `composeCoreServices`（同一实例复用，无双重组合），启动序 = CAS reconcile → core 组合 → recovery（fail → 关库 `app.exit(1)`）→ CSP/IPC/window；single-flight + 顺序重扫 + 实例内 run memo；测试 `tests/sprint14/startup-recovery.test.ts` 13 用例**）
- **Goal**：electron-free 组合模块（先例 `artifact-stack.ts`）实现启动恢复编排：Agent/Tool
  interruption（复用 recoverInterrupted / recoverInvocations）→ Run 恢复（复用 engine.recover，
  CRASHABLE + RECOVERING 分支）→ 结构化 transient report；`main.ts` 启动序第 5 步插入
  （CAS reconcile 之后、IPC/window 之前）；SAFETY FAILURE → fail startup closed；single-flight。
- **不得实现** API/Quota policy 扩展（属 T14-04）。
- **Dependencies**：T14-01。 **Files**：`apps/desktop/src/recovery-stack.ts`（拟）、`main.ts`、
  `tests/sprint14/`（组合级）。
- **Acceptance**：自动/人工矩阵全绿（S14_TEST_STRATEGY §A/§B/§E/§F/§G）；provider calls=0、
  auto-retry=0、WAITING 族零触碰、PAUSED skip+report、fail-closed、幂等二次调用零新事件。

### Task-14-03 Crash Recovery End-to-End（**已完成：`tests/sprint14/crash-recovery-e2e.test.ts` 7 用例——真实 restart harness（openRestartFixture/reopenRestartFixture：真实 SQLite 重开 + 同 CAS 根 + 全新对象图，零实例复用）覆盖 §44 全部 15 项矩阵：3-stage 崩溃→重启→续行、已完成 Stage 不重跑（handler 计数=0 + attempts 不变 + artifact 三重身份不变）、RUNNING dead-attempt（attempts=2）、agent/tool residue、WAITING/PAUSED 零触碰、RECOVERING 不重复 crash_detected、crashable 六态矩阵、证据门恢复后仍拒（无证据）/真证据放行、run-pinned v1 策略跨重启、事件可查、CAS fatal 阻断恢复、二次真实重启=新崩溃周期**）
- **Goal**：真实 SQLite + 重启组合：in-flight residue（run/agent/tool 各态）→ startup recovery →
  resumePoint → continue → 已完成工作不重复（attempts/steps 断言）→ 事件流可查（AC14.1 Crash 侧 /
  AC14.2 / AC14.3）。
- **Dependencies**：T14-02。
- **Acceptance**：completed Stage non-repeat；EvidenceGate 恢复后仍强制；event trail 完整。

### Task-14-04 Dependency-Failure Recovery（**已完成：`tests/sprint14/dependency-failure-recovery.test.ts` 8 用例——canonical 分类契约（Sprint 6 kinds：quota_exhausted 非 retryable vs unavailable/timeout/rate_limited retryable=仅元数据）；API Error 与 Quota 两条真实 restart E2E（durable FAILED + provider.failed/agent.execution_failed 审计、启动零 provider 调用、同 Run/Task 显式续行成功、旧失败行保留可审计）；持续失败 N 显式=N 调用无循环；FAILED≠crash residue；结构锁（无 setInterval/nextRetryAt/WAITING_QUOTA/RETRY_SCHEDULED）+ 依赖故障重启后 EvidenceGate 仍拒**；零 production 改动**）
- **Goal**：按 ADR-0022 落地 API Error + Quota：故障注入（模拟 provider 失败，复用 provider-error
  分类）→ attempt 终止 + durable 留痕 → 上下文保全断言 → 显式继续后从既有 context 恢复且不重复。
- **Dependencies**：T14-01（架构）；实现可与 T14-03/05 并行，验收依赖 T14-02 编排器就位。
- **Acceptance**：零 background/persistent retry；无新状态；AC14.1 API/Quota 侧。

### Task-14-05 Tool Failure Recovery End-to-End（**已完成：`tests/sprint14/tool-failure-recovery.test.ts` 6 用例——三进程 E2E（A 崩溃留 STARTED → B 重开恢复 INTERRUPTED/启动 adapter=0 → 显式 retryInvocation=新 attempt（parent/root/attemptNumber=2/独立幂等键/旧行不可变）→ 引擎正常续行 Stage B → C 二次重开 lineage+事件+ADR-0018 replay 零重执行）；fail-closed 矩阵（非幂等 INTERRUPTED 拒/FAILED 拒/WAITING_APPROVAL 拒/COMPLETED 拒+replay 路径/未授权拒）；attempt 2→3 lineage；结构锁（启动/recovery 零 retryInvocation、零 timer）**；零 production 改动——既有 Sprint 9/9.1 契约完全满足**）
- **Goal**：复用 INTERRUPTED / retryInvocation / idempotency / attempt 链：manual retry →
  run continues → no duplicate side effect（AC14.1 Tool Failure 侧）。
- **Dependencies**：T14-02。

### Task-14-06 Sprint 14 Full Regression / Closeout（**已完成：`docs/SPRINT14_CLOSEOUT.md`；全量门禁 5×PASS、116 文件/1258 用例全绿、零迁移/零依赖/零 renderer/零 authorities 变更审计通过、空库 12 链+Recovery 栈验证、tag `sprint-14.0.0`**）
- **Goal**：全量门禁（只增不减）+ 架构一致性审计 + 文档收口 + `PROJECT_HANDOFF`/roadmap 状态 +
  tag `sprint-14.0.0`（依 G6 惯例）。
- **Dependencies**：全部。

## Deferred Work（只记录，不实现）

- Approval expiry（`expired` 状态的转移者；无 timer/scheduler/lazy expiry/startup sweep）。
- Runtime Workspace entity（如未来需要，独立 ADR）。
- Recovery renderer UX（未冻结；人工面继续用既有 IPC ops）。
- 新恢复事件词汇（仅当证明 EVENT_VOCABULARY_GAP 后裁定）。
