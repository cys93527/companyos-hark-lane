# Sprint 14 Closeout — Recovery（T14-01–T14-06）

> 状态：**CLOSED**（本文为 Sprint 14 最终收口记录；独立评审 = Boss 逐 Task review，最终以
> `TASK-14-06 APPROVED` + Final Review 为准）。真实 commit hash 见本文与 `PROJECT_HANDOFF.md`。

## 1. Mission（roadmap 冻结原文）

失败是流程的一部分；系统能从中断处继续（规划书 §四十五 / §二 原则 9 / §四十三）。
四类故障（Crash / API Error / Quota / Tool Failure）各有可复现恢复用例（AC14.1）；恢复后从最近事件
继续、已完成工作不重复、用户无需重新解释目标（AC14.2）；恢复事件可在事件流查到（AC14.3）。

## 2. Delivered Capabilities（→ IMPLEMENTED / TESTED / DOCUMENTED）

| # | Capability | 实现 | 测试证据 | 文档 |
|---|---|---|---|---|
| 1 | Recovery 架构冻结 | ADR-0021/0022/0023 Accepted + S14 契约三份 | docs guards 全绿 | `docs/sprint14/` + `docs/adr/` |
| 2 | Quiescent Startup Recovery Orchestrator | `packages/engine/src/recovery/startup-recovery.ts`（electron/fs/SQLite-free，组合既有原语；agent→tool→run 冻结顺序；CRASHABLE_STATES 权威集 additive export） | `startup-recovery.test.ts` 13 用例 | ADR-0021 |
| 3 | 生产启动序接线 | `main.ts`：DB→CAS reconcile→`composeCoreServices`（单实例抽取，无双重组合）→recovery（SAFETY FAILURE→关库 `app.exit(1)`）→CSP/IPC/window | 同上（源码序锁）+ composition 级 | ADR-0021 D1 |
| 4 | Crash Recovery E2E | —（纯证据；真实 SQLite 重开+新对象图 harness） | `crash-recovery-e2e.test.ts` 7 用例（§44 全 15 项矩阵） | S14_CONTRACT |
| 5 | Dependency-Failure Recovery（API Error + Quota） | —（既有行为满足 ADR-0022，零 production 改动） | `dependency-failure-recovery.test.ts` 8 用例 | ADR-0022 |
| 6 | Tool Failure Recovery E2E | —（Sprint 9/9.1 契约满足，零 production 改动） | `tool-failure-recovery.test.ts` 6 用例（三进程 E2E） | S14_CONTRACT §10 |
| 7 | Recovery report（transient） | orchestrator 9 字段结构化报告 + 主进程日志 | startup-recovery 测试 | ADR-0021 D9 |

## 3. Recovery Model（一句话摘要）

**恢复 = 编排既有冻结原语，绝不新增执行**：quiescent startup 在 CAS 完整性之后、任何暴露之前，
按 agent→tool→run 顺序把**未知副作用残留**（RUNNING/WAITING_EXTERNAL/STARTED）收敛为安全终态
INTERRUPTED，把 crashable run 经 `engine.recover` 送回 `resumePoint`；**已知失败**（FAILED）不是
crash residue、恢复零触碰；一切业务执行只发生在**显式 continuation**（engine advance/drive/dispatch、
runtime.execute、人工 retryInvocation）。

## 4. ADR Summary

- **ADR-0021 Startup Recovery Orchestration**：启动序 8 步、agent→tool→run、自动 interruption/禁
  auto-retry、WAITING 族/PAUSED 零触碰、SAFETY FAILURE=fail closed、部分恢复不回滚、
  single-flight（并发共享/顺序重扫+实例内 memo，§23 精确化）、transient report+EventStore 审计真相、
  零新 IPC/持久化。
- **ADR-0022 Dependency-Failure Recovery**：三禁令（无持久重试调度器/后台循环/新重试状态）；
  API Error 沿用 provider-error 分类（recon 落定：**无 in-attempt retry**，1 显式执行=1 provider
  调用，retryable 仅元数据）；Quota 零自动重试；上下文保全、用户零重述。
- **ADR-0023 Recovery Path Scope**：Workspace 非实体（NO-OP/DEFERRED）；链条 Last Durable Event→
  Run→Task→Handoff（如存在）→Artifact（如存在）→Continue；Artifact 只复用 refs。

## 5. 三条 E2E 证据链

- **Crash**（`crash-recovery-e2e.test.ts`）：3-stage 真实崩溃→重开恢复→resumePoint→显式续行；
  Stage A handler 零重跑、attempts 1/2/1、artifact 三重身份不变、恢复事件零重复；六态 crashable
  矩阵；RECOVERING 不重发 crash_detected；WAITING/PAUSED 零触碰；CAS fatal 阻断恢复；
  二次真实重启=新崩溃周期。
- **API Error / Quota**（`dependency-failure-recovery.test.ts`）：durable FAILED + 双审计
  （provider.failed/agent.execution_failed）；启动零 provider 调用；同 Run/Task/versionId 显式
  续行成功；持续失败 N 显式=N 调用；FAILED≠crash residue；恢复后 EvidenceGate 仍拒。
- **Tool Failure**（`tool-failure-recovery.test.ts`）：STARTED→恢复 INTERRUPTED（启动 adapter=0）
  →显式 retryInvocation=新 attempt（parent/root/attemptNumber/独立幂等键，旧行不可变）→引擎正常
  续行；attempt 2→3 lineage；非幂等 POLICY_DENIED；FAILED/WAITING/COMPLETED 一律拒；
  ADR-0018 replay 跨重启零重执行；未授权拒。

## 6. Safety Invariants（收口时点全部成立）

1. **No automatic replay**：启动恢复期间 provider=0、tool adapter=0、Artifact create=0、
   Validation 执行=0、stage handler=0（计数断言）；恢复≠执行，业务只走显式 continuation。
2. **Unknown side-effect → fail-closed policy**：INTERRUPTED+NONE 幂等模式的人工 retry 也
   POLICY_DENIED；**诚实声明**：外部副作用"exactly once"不可证明（未知窗口存在）——可证明的是
   no automatic replay + unsafe retry fail-closed + idempotency policy enforced + attempt history durable。
3. **已知失败与崩溃残留严格分离**（FAILED≠residue；恢复后 PAUSED 仍永不自动恢复）。
4. **EvidenceGuard 恢复后仍强制**（无证据 VALIDATION.PASS 拒；run-pinned validatorIds 权威）。
5. **CAS 完整性先于恢复**（metadata→CAS missing → 启动在恢复前 fail closed）。
6. **CommandLedger=有界 retry cache**，永久恢复真相=entity/execution 行+事件史+permanent identity。
7. **授权**：SESSION_ACTOR + bootstrap owner + sessionAuthorize（无 allow-all；未授权 retry 拒）。

## 7. Migration Summary

**零 schema 变更**：Sprint 14 无新表/新列/新迁移（`git diff 641f28c..HEAD -- migrations/` 为空）。
空库 12 链迁移 + CAS foundation + Sprint 13 组合 + Recovery 栈构造/运行 全部通过（T14-06 §27 证据）。
重启兼容性由三条 E2E 的真实 close/reopen 证明，无需历史 schema 伪造。

## 8. Test Evidence（收口时点）

- `pnpm check` 5× PASS（lint/typecheck/boundaries/test/build）；vitest **116 文件 / 1258 用例全绿**
  （Sprint 13 收口基线 112/1224 → +4 文件 +34 用例，只增不减）；`pnpm test:scripts` 23/23；
  `git diff --check` clean；Sprint 14 touched 文件 UTF-8 有效、0 U+FFFD。
- 新增套件：`tests/sprint14/` 四文件 33 用例（startup-recovery 13 + crash-e2e 7 + dependency 8 + tool 6）。

## 9. Known Limitations（诚实记录 — 有意范围/延后，非缺陷）

1. 外部副作用 exactly-once 不可证明（未知副作用窗口；安全=策略 fail-closed，见 §6.2）。
2. 非幂等工具的 INTERRUPTED 人工 retry 亦被拒（POLICY_DENIED——这是安全特性）。
3. **FAILED ToolInvocation 无 retryInvocation 路径**（既有契约：仅 INTERRUPTED+幂等可 retry；
   未来如需 FAILED-retry 需独立架构决策）。
4. Approval expiry 仍 Deferred（无 timer/scheduler/lazy expiry；pending 保持 pending）。
5. 无 retry scheduler / 后台重试 / 轮询（ADR-0022 三禁令，有意）。
6. 无 runtime Workspace 实体（ADR-0023，deferred）。
7. Recovery report 为 transient（durable 真相=EventStore+行）。
8. CommandLedger 有界、非永久真相。
9. 无 Sprint 14 renderer 恢复 UX（人工面=既有 IPC ops）。
10. Agent runtime 无 in-attempt retry（1 显式执行=1 provider 调用；retryable 仅分类元数据）。

## 10. Deferred Work（只记录，不实现）

approval expiry 语义；runtime Workspace 架构；恢复 UI；重试调度（如未来批准）；外部 exactly-once/
幂等集成；FAILED-tool retry 政策（如单独设计）。

## 11. Final Record

- Commit 链：`857b52a`（T14-01 架构冻结）→ `ce94abc`（T14-02 编排器）→ `36d988d`（T14-03 Crash
  E2E）→ `35a2a14`（T14-04 依赖故障）→ `69631c4`（T14-05 Tool E2E）→ `7c8deeb`（contract recon
  补记）→ closeout commit（见 `PROJECT_HANDOFF.md`）。
- Tag：`sprint-14.0.0`（依 G6 惯例 + Sprint 14 Git Checkpoint `sprint-14` + sprint-1.0.0…
  sprint-13.0.0 先例），指向最终 closeout HEAD；未 push。
- T14-01–T05 全部 CLOSED（逐 Task 独立 commit + review），T14-06 = 本文 + 文档收口 + 最终回归 + tag。
