# ADR-0021：Startup Recovery Orchestration（Sprint 14 — Task-14-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-14-01 APPROVED` 指令全文）**。
> 配套：ADR-0005（Engine Boundary & Idempotency）· ADR-0006（Durable UoW & Idempotency）· ADR-0018/0019（Tool 溯源）·
> `docs/sprint14/S14_RECOVERY_CONTRACT.md`（运行时契约全文）。

## Context

Sprint 14 之前的恢复原语分散且全部冻结，但互相不编排：Sprint 2 交付引擎崩溃恢复
（`engine.recover` + `resumePoint` 语义 + `run.crash_detected/recovered/recovery_failed` 事件）；
Sprint 8 交付 `recoverInterrupted`（Agent RUNNING/WAITING_EXTERNAL → INTERRUPTED，绝不重调 provider）；
Sprint 9/9.1 交付 `recoverInvocations`（Tool STARTED → INTERRUPTED）与人工 `retryInvocation` 链；
Sprint 13 交付永久 creation identity、CAS 启动对账与启动序冻结。生产 desktop 启动路径（Task-13-11）
**没有任何恢复编排**：不扫描 crashable run、不调用上述 recover*，`agent.recover`/`tools.recover`
仅为人工 IPC。本 ADR 冻结"谁、何时、按什么顺序、失败怎么办"。

## Decision 1：启动时序（Quiescent Recovery）

```text
1. open DB + migrations
2. Artifact/CAS reconciliation（Task-13-11 冻结，fatal → fail startup closed）
3. CAS integrity PASS
4. construct recovery dependencies
5. run Startup Recovery Orchestrator
6. recovery PASS
7. construct/expose healthy application runtime
8. register IPC / create window
```

恢复编排**必须**位于 CAS reconciliation 之后（损坏库上的恢复无意义）、IPC/window/外部命令暴露之前
（QUIESCENT STARTUP——与 CAS reconciliation 同一纪律：无并发命令）。**禁止** background recovery
与正常 commands 并发；orchestrator 是一次性 quiescent 能力，不是常驻服务。

## Decision 2：自动恢复顺序

```text
A. Agent executions（外部副作用可能性最高，先归入安全 durable 状态）
B. Tool invocations
C. Workflow Runs（最后恢复 run 状态）
```

## Decision 3：Agent 恢复（自动 interruption，禁止 auto-retry）

启动扫描 `AgentExecution: RUNNING / WAITING_EXTERNAL`，调用**既有** `recoverInterrupted(...)`
（分页扫描、审计 `agent.execution_interrupted` 带 previousStatus），转换为终态 `INTERRUPTED`。
**Provider calls = 0**（Sprint 8 冻结：恢复绝不重新调用 provider）。禁止
`INTERRUPTED → rerun provider` 与 `RUNNING → restart execution`；后续重执行只属于显式
continuation/retry path。

## Decision 4：Tool 恢复（自动 interruption，禁止 auto-retry）

启动扫描 `ToolInvocation: STARTED`，调用**既有** `recoverInvocations(...)` → `INTERRUPTED`
（审计 `tool.invocation_interrupted`）。**即使工具幂等，启动恢复也不自动 `retryInvocation()`**；
Sprint 9.1.2 冻结的人工 retry 链保持唯一重试路径。ADR-0018/0019 全部继续有效。

## Decision 5：WAITING 族 = durable waiting state，不是 crash residue

`ToolInvocation WAITING_APPROVAL`、`WorkflowRun WAITING_APPROVAL`、`Approval pending`
**不改变**：启动恢复对它们 does not approve / does not reject / does not retry / does not expire，
只报告。同理 `PAUSED` run **永远不自动恢复**（人工决定语义，Sprint 2 测试 K 锁定）：skip + report。

## Decision 6：Run 恢复（crashable 集合 + engine.recover 安全性核实）

Agent/Tool residue 处理完成后，对仓库真实 CRASHABLE 集合
（`PLANNING/ROUTING/EXECUTING/REVIEWING/VALIDATING/FINALIZING`，`engine.ts` 冻结常量）的 run
自动执行**既有** `engine.recover(runId)`，恢复至既有 `resumePoint` 语义。

**安全性核实结论（Task-14-01 recon，符合本 ADR）**：`engine.recover` 内部仅 dispatch
`CRASH.DETECTED` / `RECOVERY.COMPLETE` 两个纯状态机命令（ledger replay → route → L1 转移 →
UoW 写 run/event/ledger）；stage handler 只在 `drive`/`advance` 路径执行，CRASH/RECOVERY 命令
不触碰任何 handler。因此 **engine.recover at startup may recover durable run state but MUST NOT
automatically execute external Agent / Tool / Provider side effects** 在当前实现下成立——恢复后
run 处于执行相位，等待**显式** continuation，不在启动时自动推进。此为 ADR 级约束：任何未来改动
不得使 recover 路径触发外部副作用。

**RECOVERING 跨重启**：发现 `RECOVERING` run 时**不得重发 CRASH_DETECTED**，沿既有状态机
`RECOVERING → RECOVERY.COMPLETE → resumePoint`。当前 `engine.recover` 已优先处理该分支
（`engine.ts:1019`），无需实现变更。

**Task RUNNING**：启动编排**不批量改写 Task 状态**（禁止 RUNNING → PENDING/FAILED）；
引擎 continuation/drive 时对 RUNNING dead attempt 的既有处理（计入 attempts 后重跑）保持权威。

## Decision 7：启动失败策略（SAFETY FAILURE = FAIL CLOSED）

枚举/持久化错误、恢复事件写入失败、corrupt durable row、非法恢复转移、部分恢复操作抛错 →
**fail startup closed**：不暴露健康 runtime、不注册普通 IPC、不创建应用 window（与 CAS fatal
同一先例）。下一次 startup 重新运行 orchestrator。

**非失败状态**（report + 保持 durable 状态 + 启动继续）：PAUSED、WAITING_APPROVAL、pending
approval、等待人工 retry 的 INTERRUPTED tool、等待 continuation 的 INTERRUPTED agent。

**部分恢复**：不建跨子系统分布式事务。若 Agent 恢复成功而 Tool 恢复失败 → startup fail closed；
已完成的 Agent interruption **不回滚**（操作必须幂等、retry-safe——mark-INTERRUPTED 本身幂等），
下次 startup 继续扫描剩余状态。

## Decision 8：Orchestrator 幂等（single-flight；Task-14-02 §23 精确化澄清）

- **并发调用**：`run()` 进行中的第二个并发调用**共享同一 in-flight Promise**，绝不启动第二轮
  扫描。
- **顺序调用**（首次已完成后再次调用）：**必须重新扫描**（durable 状态可能已变化），不得返回
  首次缓存 report。语义澄清（取代本文初版"返回首次 report"的表述）：Agent/Tool 扫描天然幂等
  （状态过滤：already-INTERRUPTED → 零新事件、零新动作）；Run 恢复以 orchestrator 实例内
  **memo**（本实例已恢复的 runId 集合）实现 §17 "already recovered Run → no duplicate
  crash/recovery cycle"——恢复后的 run 合法停留在其 resumePoint（crashable 态）等待**显式**
  continuation，重扫识别为自己的产物即跳过；**真正新增的 residue**（首次扫描后新崩溃的 run）
  不在 memo 中、仍会被恢复。跨**进程重启**：新实例空 memo，真实新崩溃周期照常恢复并产生新事件。

## Decision 9：Recovery Report（transient；EventStore = durable audit truth）

Orchestrator 返回结构化 transient report（建议字段：`agentExecutionsInterrupted` /
`toolInvocationsInterrupted` / `toolInvocationsWaitingApproval` / `runsRecovered` /
`runsAlreadyRecoveringCompleted` / `runsPaused` / `manualInterventionRequired` / `failures`，
最终字段服从 repo style），经既有主进程结构化日志输出。**不建 recovery_report 表**：
durable 留痕由既有事件族满足（`run.crash_detected/recovered/recovery_failed` +
`agent.execution_interrupted` + `tool.invocation_interrupted`）。

## Decision 10：无新 IPC / 无新持久化

启动编排器是 trusted main-process capability，不新增 renderer Recovery API（继续复用既有
`agent.recover` / `tools.recover` / `tools.retry` / `tools.approve` 人工面）。新表/新列/新迁移：
NONE。CommandLedger 定位不变：**retry cache，非永久恢复真相**——启动恢复不得以
"bounded ledger 中缺席"推导实体不存在；永久依据 = entity 行 + execution 行 + event history +
permanent creation identity。

## Rejected

- 启动时自动 retry 幂等工具（违反显式重试契约；crash 后无法证明副作用状态时自动重跑越权）。
- 启动时批量改写 Task/RUNNING 状态（静默状态改写，破坏审计）。
- Background/定时 recovery（与正常命令并发，破坏 quiescent 纪律）。
- Recovery report 持久化表（EventStore 已是 durable 审计真相）。
- Approval expiry（`expired` 状态转移者问题）：**OUT OF SPRINT 14**——不新增 timer/scheduler/
  lazy expiry/startup sweep；pending 保持 pending 直到既有明确 user action；登记 Deferred Work，
  不创建 ADR-0024。

## Consequences

- Sprint 0–13 冻结面零改动：全部复用既有 recover* API 与事件词汇（本 ADR 不新增事件类型；
  若实现期发现词汇不足以满足 AC14.3，只能登记 `EVENT_VOCABULARY_GAP` 报告裁定，不得自行新增）。
- 实现落点（Task-14-02）：electron-free 组合模块（先例 `artifact-stack.ts`）+ `main.ts` 启动序
  第 5 步插入 + 组合级测试。
- 门禁：`pnpm check` / test 只增不减；本文档变更不触碰 packages/apps/tests。
