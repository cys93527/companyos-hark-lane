# ADR-0005：Workflow Engine 的边界、幂等与并发策略

> 归属：Sprint 2（Workflow Engine，P0）；规划书 §二原则 6、§三十三、§三十四、§四十五；
> 上游 ADR-0002（端口冻结）、ADR-0003（状态分层）。

## 状态

**已接受（Accepted）** — Sprint 2 交付。

## 背景

Sprint 1 交付了行业无关的 Core Domain、L1 状态机（17 态）与冻结的端口（11 个），但**没有任何东西
真正推进状态**：`WorkflowEnginePort` 只有契约。Sprint 2 必须让状态机"动起来"，同时不破坏三条既有约束：

1. Core 行业无关、零运行时依赖（AGENTS.md §1.1–1.3）；
2. Orchestrator 是**确定性制度**，不是"让模型决定下一步"（规划书 §二原则 6）；
3. 本 Sprint 禁止 Model Router / Agent Runtime / 真实 Provider / DevCompany 等
   （用户约束 + AGENTS.md §3）。

此外还暴露了三个必须一次性想清楚的问题：**谁写状态**、**如何做到 exactly-once**、**并发怎么不丢更新**。

## 决策

### 1. 引擎是独立的外环包，只依赖 Core

- 新增 `@companyos/engine`（`packages/engine`），运行时依赖**仅** `@companyos/core`；
- 命令词表（`RunCommand`）放在 **Core**（跨边界契约），引擎只做解释与执行；
- 执行者通过 `StageHandlerRegistry` 注入；Sprint 2 只有确定性 stub；
- 边界由三处自动化证据强制：`packages/engine/tests/boundary.test.ts`（包清单 / import 扫描 /
  标识符扫描 / 厂商名扫描 / 能力扫描）、`scripts/check-boundaries.mjs` 的 `ALLOWED_INTERNAL_DEPS`、
  ESLint 规则。

### 2. 唯一状态写入口是 Core

引擎**不写** `state` 字段，只调用 `Core.applyRunEvent`。非法转移、终态吸收、返工预算、
恢复点语义全部由 Core 拥有并测试；引擎负责编排（路由、副作用、持久化、事件、串行化）。

### 3. 幂等 = `commandId` + 内容指纹 + 有界账本

- 同一 `commandId` 只产生一次效果；重放返回首次 `DispatchOutcome`（`duplicate: true`）；
- 同一 `commandId` 携带不同内容 ⇒ `CONFLICT`（防"改一半再重试"）；
- 账本有上界（默认 1000，FIFO 淘汰）；被淘汰的旧命令不再视为重复，而会因 revision 过期被拒——
  即**幂等窗口有界且可解释**，不做"永久记住所有命令"的假承诺。

### 4. 并发 = 乐观并发（revision）+ 同 Run FIFO 串行化

- `WorkflowRun.revision` 每次成功应用事件 +1；命令必须携带 `expectedRevision`；
- 不匹配 ⇒ `CONFLICT`（`details.reason='stale_revision'`），零写入；
- 引擎为每个 `runId` 维护 promise 链：同 Run 命令按到达顺序执行，跨 Run 互不阻塞；
- 因此"两条并发命令"的结果只有两种可能：**一条成功一条冲突**，或**两条按序双双成功**；
  第三种（丢更新）在结构上不可能。

### 5. 内部路径不重入串行链（Sprint 2 实测缺陷）

`executeStage` 在临界区内需要派发 `EXECUTION.COMPLETE/FAIL`。若走公共 `dispatch`，
会再次等待自己所在的 promise 链 → **自死锁**（Sprint 2 测试首轮即触发 5 秒超时，暴露该缺陷）。
决策：内部派发使用 `alreadySerialized = true` 直通 `execute`，公共 API 仍串行化。

### 6. 引擎绝不替人做决定

driver 在 `WAITING_APPROVAL`、`PAUSED`、终态、以及"进入 `EXECUTING` 但没有 stage 描述"时**停止并报告原因**，
不猜测、不自动批准、不自动恢复（规划书 §四十五）。审批决策必须由持有 `run.approve` 授权且**非发起人**
的 actor 发出。

## 后果

**收益**

- 状态推进可被机器验证：A–L 十二个场景 + 需求 10–16 全部有独立测试；
- Core 与引擎的职责边界清晰：领域不变量在 Core，编排在引擎，执行在注入的 handler；
- 幂等与并发策略不依赖时钟或数据库锁，跨机器可复现（固定 `Clock` + `IdFactory` 下逐字节一致）；
- 未来接入真实 Agent Runtime 时，**不需要改 Core**，只需替换 `StageHandlerRegistry`。

**代价与限制**

- 幂等账本在内存（Sprint 2），进程重启后重复命令会重新执行 —— 已列入 `PROJECT_HANDOFF.md` 的
  Known Limitations，Sprint 3 落库解决（`command_ledger`）；
- 同 Run 串行化意味着单个 Run 的吞吐受限于顺序执行（V1 单 Workspace、串行 Agent 的既定选择）；
- `executeStage` 的"任务状态归一化"（`RUNNING`→`FAIL`→`RETRY`）是对崩溃中断的工程化处理，
  真实的中断语义需要 Sprint 3 的 checkpoint 支撑；
- **状态写入与事件追加当前不在同一事务**（引擎先 `runs.put` 再 `events.append`），
  与 `docs/STATE_MACHINE.md` §10 的目标（同一事务）存在偏差；Sprint 3 用 Core 的 `UnitOfWork`
  端口收敛。偏差已在此显式记录，而不是默认它不存在；
- **`StageHandler` 在 per-run 临界区内执行**，契约上不得回调 `dispatch`（会等待自己所在的 promise 链）。
  引擎用重入守卫把它变成可观测的 `CONFLICT`（`details.reason='reentrant_dispatch'`），
  但真正的实时性风险仍由 handler 的实现纪律承担。

**副作用顺序（Sprint 2 评审后的硬约束）**

`execute` 的顺序固定为：**纯校验（`applyRunEvent`）→ 审批副作用 → 持久化 Run → 追加事件**。
首轮实现把审批副作用放在校验之前，导致"非法转移也会写下 pending 审批"（评审 HIGH）。
现在任何被拒绝的命令都**零副作用**，并有回归测试断言 `approvals.snapshot()` 保持为空。

**事件发射方唯一性**

Core 的 `CORE_EVENT_EMITTERS` 为每个目录条目声明**唯一**发射方；尚未实现的条目注明归属 Sprint，
并由 `core/tests/domain/event-emitters.test.ts` 断言覆盖完整——审计词表里不允许出现无人发射的条目。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 引擎直接写 `run.state` | 会把不变量复制到第二个地方，违反单一真相源；非法转移可能被绕过 |
| 把命令词表放进引擎包 | 命令是跨边界契约，UI/Pack/未来 adapter 都要发；放在外环会形成反向依赖 |
| 用数据库行锁/挂钟做并发控制 | 与"确定性 Orchestrator"冲突，且不可复现；revision 更简单且可测试 |
| 让 LLM 决定下一步 | 直接违反规划书 §二原则 6 |
| 引擎内置一个真实 Agent Runtime | Sprint 2 明令禁止（§3 禁止项） |
| 永久保留所有 commandId | 内存/表无界增长；有界账本 + revision 过期同样安全且可解释 |

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | Sprint 2 | 初版：外环引擎边界 + 幂等账本 + revision 乐观并发 + 串行化与重入修复 |
