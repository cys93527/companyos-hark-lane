# S14 Recovery Contract（Sprint 14 — Task-14-01 Architecture Freeze）

> 状态：**FROZEN**（Accepted：`TASK-14-01 APPROVED` 指令全文，2026-09-26）。
> 配套：`docs/adr/0021-startup-recovery-orchestration.md` · `docs/adr/0022-dependency-failure-recovery-policy.md`
> · `docs/adr/0023-recovery-path-scope.md` · `docs/sprint14/S14_TASK_BREAKDOWN.md` · `docs/sprint14/S14_TEST_STRATEGY.md`。
> 总原则：失败是流程的一部分；系统从中断处继续（规划书 §二 原则 9 / §四十五 / §四十三）。
> **本 Sprint 不新增任何业务能力面（无新 IPC / 无新表列迁移 / 无新事件），只编排既有冻结原语。**

## 0. 恢复能力 provenance（真实出处，纠错声明）

**不得在任何 Sprint 14 文档写 "Sprint 11 delivered restart recovery"**（Sprint 11 = Structured
Handoff，与恢复无关）。真实出处：

| 能力 | 出处 |
|---|---|
| engine crash recovery / `resumePoint` / CRASH_DETECTED/RECOVERED/RECOVERY_FAILED | Sprint 2（`run-state.ts` + `engine.ts` + crash-recovery 测试） |
| Agent interrupted recovery（RUNNING/WAITING_EXTERNAL → INTERRUPTED，provider calls=0） | Sprint 8（`recoverInterrupted` + `agent.execution_interrupted`） |
| Tool interrupted recovery / 人工 retry 链 | Sprint 9 / 9.1（`recoverInvocations` / `retryInvocation` + `tool.invocation_interrupted`） |
| durable provenance / CAS integrity / idempotent Artifact+Validation | Sprint 13（ADR-0015~0020） |

## 1. 启动时序（ADR-0021 D1）

```text
1. open DB + migrations
2. Artifact/CAS reconciliation（fatal → fail startup closed，Task-13-11 冻结）
3. CAS integrity PASS
4. construct recovery dependencies
5. run Startup Recovery Orchestrator   ← 本契约新增步骤
6. recovery PASS
7. construct/expose healthy application runtime
8. register IPC / create window
```

QUIESCENT STARTUP 纪律：恢复在 CAS 之后、IPC/window/外部命令暴露之前；禁止 background
recovery 与正常命令并发。

## 2. 自动恢复矩阵（Automatic Recovery Matrix）

顺序 A → B → C（先归档外部副作用可能性最高的 execution，再恢复 Run）。

| 步骤 | 扫描对象（真实状态） | 动作 | 复用 API | 审计事件 | 禁止 |
|---|---|---|---|---|---|
| A | AgentExecution `RUNNING` / `WAITING_EXTERNAL` | → `INTERRUPTED` | `recoverInterrupted`（分页） | `agent.execution_interrupted`（带 previousStatus） | 重调 provider（calls=0）、restart execution、auto-retry |
| B | ToolInvocation `STARTED` | → `INTERRUPTED` | `recoverInvocations`（分页） | `tool.invocation_interrupted` | 自动 `retryInvocation`（即使幂等；人工链唯一） |
| C | WorkflowRun ∈ CRASHABLE：`PLANNING/ROUTING/EXECUTING/REVIEWING/VALIDATING/FINALIZING` | `engine.recover(runId)` → resumePoint | `engine.recover`（既有） | `run.crash_detected` + `run.recovered` | 自动执行 stage handler / 外部副作用；恢复后等待显式 continuation |
| C' | WorkflowRun `RECOVERING`（跨重启残留） | `RECOVERY.COMPLETE` → resumePoint（**不重发 CRASH_DETECTED**） | `engine.recover` RECOVERING 分支 | `run.recovered` | 重复 crash/recovery 周期 |

`engine.recover` 安全性已核实（Task-14-01 recon）：仅 dispatch `CRASH.DETECTED` /
`RECOVERY.COMPLETE` 纯状态机命令（ledger replay → route → L1 转移 → UoW 写 run/event/ledger）；
stage handler 只在 `drive`/`advance` 路径执行。ADR 级约束：**任何未来改动不得使 recover 路径触发
外部 Agent/Tool/Provider 副作用**。

## 3. 人工-only矩阵（Manual-Only Matrix：report + 保持 durable 状态 + 启动继续）

| 状态 | 语义 | 后续路径 |
|---|---|---|
| WorkflowRun `PAUSED` | 永不自动恢复（人工决定，Sprint 2 测试 K） | 人工 RESUME |
| WorkflowRun `WAITING_APPROVAL` / Approval `pending` | durable waiting，非 crash residue；不 approve/reject/retry/expire | 人工 APPROVAL.GRANT/DENY |
| ToolInvocation `WAITING_APPROVAL` | 原样保留 | 人工 approve（版本漂移 fail-closed，ADR-0019） |
| ToolInvocation `INTERRUPTED`（含本次恢复产物） | 等待人工 | `tools.retry`（仅幂等工具，attempt 链） |
| AgentExecution `INTERRUPTED`（含本次恢复产物） | 等待 continuation | 显式重新发起执行 |
| Task `RUNNING` | **启动不批量改写**（禁止 RUNNING→PENDING/FAILED） | 引擎 continuation/drive 的 dead-attempt 语义权威（attempts 计数后重跑） |

**Approval Expiry：OUT OF SPRINT 14**——`expired` 状态存在但不新增 timer/scheduler/lazy
expiry/startup sweep；pending 保持 pending 直到既有 user action（Deferred Work，无 ADR-0024）。

## 4. resumePoint 权威（Authority）

`WorkflowRun.resumePoint` 持久字段为权威恢复点：`RECOVERED` 事件返回该点；无记录 → 规则默认
目标；非执行相位 resumePoint → `ILLEGAL_TRANSITION` fail-closed（不可跳 gate，Sprint 2 HIGH-2
修复冻结）。辅助审计源 = EventStore（`readByAggregate`）。**CommandLedger = retry cache，
非永久恢复真相**；永久依据 = entity 行 + execution 行 + event history + permanent creation
identity（Sprint 13 Option B）。

## 5. 启动失败策略（fail-closed）

SAFETY FAILURE（store 枚举错误 / 持久化错误 / 恢复事件写入失败 / corrupt durable row /
非法恢复转移 / 部分恢复操作抛错）→ **fail startup closed**：不暴露健康 runtime、不注册普通
IPC、不创建应用 window；下次 startup 重新运行 orchestrator。

部分恢复（如 Agent 成功、Tool 失败）→ 同样 fail closed；已完成的 interruption **不回滚**
（mark-INTERRUPTED 幂等）；下次 startup 继续扫描剩余状态。不建跨子系统分布式事务。

## 6. Orchestrator 幂等（Task-14-02 §23 精确化）

并发调用共享同一 in-flight Promise（一轮扫描）；顺序二次调用**重新扫描**——Agent/Tool 天然
幂等（状态过滤，零新事件），Run 恢复以实例内 memo 去重（本实例已恢复的 run 停留在其
resumePoint，重扫跳过；新 residue 仍恢复）。跨进程重启 = 新实例、空 memo、新崩溃周期照常恢复。

## 7. Recovery Report（transient）

结构化 transient report（字段服从 repo style，建议：`agentExecutionsInterrupted` /
`toolInvocationsInterrupted` / `toolInvocationsWaitingApproval` / `runsRecovered` /
`runsAlreadyRecoveringCompleted` / `runsPaused` / `manualInterventionRequired` / `failures`）
+ 主进程结构化日志。**无新表**：durable 审计真相 = 既有事件族（`run.crash_detected/recovered/
recovery_failed` + `agent.execution_interrupted` + `tool.invocation_interrupted`，满足 AC14.3）。

## 8. 依赖故障规则（ADR-0022 摘要）

# NO PERSISTENT RETRY SCHEDULER · NO BACKGROUND RETRY LOOP · NO NEW RETRY STATE

- **API Error**：沿用 provider-error 分类 + RETRYABLE_KINDS；已有 bounded in-attempt retry
  contract 则保留，否则 attempt 终止 + durable 留痕；恢复 = 既有 Run/Task context 的显式
  continuation/retry。
- **Quota**：不自动重试（禁 tight loop / startup retry / timer polling / background watcher）；
  不创建 WAITING_QUOTA / RETRY_SCHEDULED；quota 恢复后显式继续。
- **上下文保全**：Run/Task identity、Stage snapshot、Handoff context、Artifact references、
  （如适用）Memory/Decision references 必须保持；禁止 new Run / recreate Task / 用户重述目标。
- 事件词汇优先复用既有；不足则登记 `EVENT_VOCABULARY_GAP`，不得自行新增。
  **实现状态（T14-04）**：既有词汇充足——依赖失败 durable 审计 = `provider.failed`（kind 白名单）
  + `agent.execution_failed`；无 EVENT_VOCABULARY_GAP，零新事件。
- **Recon 落定（T14-04）**：Agent runtime **无 in-attempt retry 循环**（一次显式执行 = 一次 provider
  调用；RETRYABLE_KINDS 是记录性元数据，永不自动行动）；依赖失败 = 已知终态 FAILED（非 crash
  residue，启动恢复零触碰）；显式恢复 = 同 Run/Task 上下文的新 execution（runtime 永不自选模型，
  "恢复的 provider" 即续行所绑定的注册）；重开进程同 providerId 重注册被 CONFLICT 拒绝（durable
  注册胜出、adapter 不换绑）——恢复的 provider 以新注册呈现。

## 9. 恢复路径范围（ADR-0023 摘要）

运行时链条冻结：`Last Durable Event → Workflow Run → Task → Handoff context（如存在）→
Artifact references（如存在）→ Continue`。Workspace = conceptual working context，
**非 runtime entity**（NO-OP / DEFERRED；未来需独立 ADR）。Handoff = context reference
（不新建/不改写/不推进）；Artifact = durable prior-work identity（只复用既有 refs；
禁止 recreate/copy/mutate；Sprint 13 permanent identity 权威）。

## 10. 持久化与复用（零重做清单）

New table / column / migration：**NONE**。Sprint 13 能力 reused as-is（禁止重做）：Tool
replayOutput、toolVersion、Artifact/Validation creation identity、CAS reconciliation、
EvidenceGuard、DurableReferenceResolver。人工恢复 IPC 面复用既有：`agent.recover` /
`tools.recover` / `tools.retry` / `tools.approve`；Startup Orchestrator 为 trusted
main-process capability（无新 IPC）。
- **Tool retry recon 落定（T14-05）**：retry 资格 = 仅 `INTERRUPTED` + `idempotencyMode !== 'NONE'`（canRetryInvocation 冻结）；known FAILED / WAITING_APPROVAL / COMPLETED 一律 CONFLICT 拒绝（COMPLETED 的复用路径是 replayOutput 而非 retry）；retry = 经 registry.invoke 的全新行（parent/root/递增 attemptNumber/独立幂等键），旧行永不改写复活；版本溯源 = 新 attempt 捕获当前 durable ToolRecord.version（同 id 重注册 CONFLICT——公开 API 不可达 registry 漂移；WAITING 漂移由 ADR-0019 守卫权威）。
