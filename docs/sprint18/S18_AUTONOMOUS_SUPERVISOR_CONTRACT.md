# Sprint 18 — Autonomous Supervisor & Corrective Loop 架构契约（T18-01 冻结）

> 状态：**FROZEN（T18-01 输出；T18-02 已落地 §13 执行上下文基础设施）**。
> 权威裁定：`docs/adr/0029-autonomous-supervisor-and-corrective-work.md`（Accepted，12 条 ruling）。后续 Task 严格线性依赖，
> 逐 Task Boss 批准后执行；本文档任何条款被改动都必须回到 T18-01 重新冻结。
> 上游：`docs/EXECUTION_ROADMAP.md`、`docs/adr/0028-*.md`（Accepted）、Sprint 17 closeout
> （Repository Runtime CLOSED）、本 recon 全部引用均来自**真实 production code**（非文档推断）。
> 下游：`S18_TASK_BREAKDOWN.md`、`S18_TEST_STRATEGY.md`。

## 1. Mission

**在既有 Core/Engine/Persistence 之上，建立一个 run 范围内的 "Supervisor（监督者）" 决策与纠正
回路：它能读 durable evidence、做出可审计的决策、在受控边界内触发"纠正动作"，并在无法自行
决定时把状态持久地交还人类。**

Mission 不是"再造一个 Orchestrator"。Sprint 18 交付的是**决策与纠正的语义、持久性、幂等性与
停止条件**，而不是新的执行引擎。

## 2. Non-goals（HARD STOP 清单）

以下每一项在本 Sprint 任何 Task 中都**禁止**，除非 Boss 单独批准并修改本契约：

1. **不实现 autonomous loop 本体**（无自动驱动 run 的常驻循环、无 scheduler、无 cron）。
2. **不新增 model provider**、不改 Router 推荐算法、不改 Model Selection Policy。
3. **不做 UI / IPC / renderer 改动**：Supervisor 是 main-process 应用层能力（沿用 Sprint 13
   Task-13-11 corrective 的 "trusted main-process capability" 边界）。
4. **不做 migration / schema 变更**：不复用既有表之外的任何新表（见 §12 裁决）。
5. **不新增 authority token**（§8.3 明确列出这是 gap，**只记录不补**）。
6. **不新增 Tool**、不改 Tool Registry 的 invoke 链。
7. **不改 Pack / DevCompany manifest**、不改 Pack 框架。
8. **不改 Repository Runtime**（Sprint 17 已 CLOSED，冻结）。
9. **不改 `WorkflowVersion` / `RunSnapshot` 的不变量**，不改 L1/L3 状态机的既有转换。
10. **不让 Supervisor 直接 spawn 进程 / 写文件 / 调 git**——它对仓库的一切影响都经由既有
    Tool Registry 或既有 StageHandler。

## 3. Supervisor 定义与分层定位

**Supervisor = 一个 run 作用域内的应用服务（application service）**，满足全部四条：

1. **只读世界**：它从既有 durable 只读面取证据（ArtifactStore、ValidationStore、
   ToolInvocation 相关读路径、DecisionStore、Approval、Run/Task 状态、AgentExecution）。
2. **唯一写入口**：它只能通过**既有** `WorkflowEnginePort` 命令面（`RunCommand` → `dispatch`）
   与既有领域服务（Decision / Approval / Handoff）表达意图。**它不持有第二个 dispatcher。**
3. **可审计**：每一次决策都落 `DecisionRecord`（`packages/core/src/domain/decision.ts`），
   每一次外部可观察动作都落 command ledger 指纹（`packages/core/src/domain/commands.ts:175-183`）。
4. **可中止**：它显式实现 §11 的停止条件，任何不满足 stop-condition 前置的状态都 fail closed。

分层位置：`packages/engine/src/supervisor/`（**提案**，落点由对应 Task 的 placement recon 决定）。
依据与 Sprint 17 同一判据：engine 已持有 OS/应用 runtime primitive，而 boundary gate 禁止
Core/Contracts 引入 `node:`；Supervisor 逻辑是应用服务，属于 engine 层，Core 保持纯 domain。

## 4. Recon 发现：当前执行架构的事实基线

> 全部结论有 `path:line`；这是契约后续条款的事实依据。

### 4.1 Task 生命周期状态机（L3）

`packages/core/src/domain/task.ts`：8 状态
（`PENDING, READY, RUNNING, BLOCKED, DONE, FAILED, CANCELLED, SKIPPED`，`:12-21`）、
9 事件（`:24-34`）、转换表（`:44-54`）：

| 事件       | from                          | to        |
| ---------- | ----------------------------- | --------- |
| `PLAN`     | PENDING                       | READY     |
| `START`    | **仅 READY**                  | RUNNING   |
| `BLOCK`    | RUNNING                       | BLOCKED   |
| `UNBLOCK`  | BLOCKED                       | READY     |
| `COMPLETE` | RUNNING                       | DONE      |
| `FAIL`     | RUNNING                       | FAILED    |
| `RETRY`    | FAILED                        | READY     |
| `CANCEL`   | PENDING/READY/RUNNING/BLOCKED | CANCELLED |
| `SKIP`     | PENDING/READY                 | SKIPPED   |

- `attempts` **只由 `START` 递增**，且在 `applyTaskEvent` 里先于状态应用做上限检查：
  `attempts + 1 > maxAttempts` ⇒ `LIMIT_EXCEEDED`，任务不被修改（`:134-146`）。
  默认 `maxAttempts = 3`（`:104`）。
- 终态：`DONE / FAILED / CANCELLED / SKIPPED`（`:72-73`）。
- Stage 层（`packages/core/src/domain/stage.ts`）有 `taskIds` 字段与
  `addTaskToStage`（`:113-135`，拒绝重复与终态 stage 追加），但
  **`createStage` 永远初始化 `taskIds: []`（`:104`），且 `addTaskToStage` 在 production
  中零调用**——只出现在 `packages/core/tests/domain/stage-task.test.ts`。
- Run 层（L1，`packages/core/src/domain/run-state.ts`）：执行期只有两条出边
  `EXECUTION_DONE → REVIEWING`（`:195-200`）与 `EXECUTION_FAILED → FAILED`（`:201-207`）；
  终态 `COMPLETED / FAILED`（`:309`）。

### 4.2 今天由谁决定"下一个 Task / 顺序 / 重试 / 角色 / validator"

权威引擎 task 循环 = `packages/engine/src/engine.ts:653` `executeStageInternal`
（文档 `:648-652`），行级事实：

| 决定                                                          | 位置                | 事实                                                                                         |
| ------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| 归一化（含崩溃 recovery 的 `RUNNING → FAIL → RETRY → READY`） | `engine.ts:711-729` | 循环前一次                                                                                   |
| task 启动                                                     | `engine.ts:750`     | `await step(task, 'START')`                                                                  |
| attempt 上限短路                                              | `engine.ts:752-755` | `LIMIT_EXCEEDED` ⇒ `taskOutcome='failed'`                                                    |
| handler 解析与执行                                            | `engine.ts:761-773` | `deps.handlers.resolve(task.kind, branch)`；**handler 缺失按 `'failed'` 处理**（`:763-764`） |
| 成功                                                          | `engine.ts:775-781` | `step(task,'COMPLETE')`，**不传 outputs**                                                    |
| 阻塞                                                          | `engine.ts:782-788` | `step(task,'BLOCK')`，run 停留 EXECUTING（`:821`）                                           |
| 失败+自动重试                                                 | `engine.ts:789-799` | `FAIL`，若 `attempts < maxAttempts` 则 `RETRY` 并回到 `START`                                |
| 预算耗尽                                                      | `engine.ts:792-796` | 停留 FAILED，`taskOutcome='failed'`                                                          |
| run 级失败                                                    | `engine.ts:810-817` | `EXECUTION.FAIL`，reason=`task <id> exhausted N attempts`                                    |
| run 级成功                                                    | `engine.ts:823`     | `EXECUTION.COMPLETE`                                                                         |

事务边界：`executeStage`（`:828-841`）把 task 写、task 事件与 run 级 EXECUTION.* 包在**一个
事务**（Sprint 3 review HIGH-1）。

**排序/角色/validator 的决定者**：

- **顺序**：完全由调用方通过 `StageExecutionRequest.taskIds` / `DriveOptions.stage` 给定
  （`engine.ts:659, 945, 999`），引擎不自行排程；`drive` 的 `maxSteps` 默认 40（`:922`）。
- **角色**：`roleIdOf(node.config)` 只在 design-time graph validation 使用
  （`packages/core/src/lifecycle/graph-validation.ts:137-155`），**runtime 不读角色**。
- **validator**：run 的 **pinned version** 图节点 `config.validatorIds`
  （`apps/desktop/src/artifact-stack.ts:323-367`，fail-closed 四级
  `GATE_RUN_MISSING / GATE_TEMPLATE_MISSING / GATE_VERSION_MISSING / GATE_STAGE_MISSING`），
  消费方 `packages/engine/src/validation/evidence-guard.ts:95`（R2-B：latest durable batch wins，
  无 fallback、无跨 batch 拼装；`requiredIds.length === 0` ⇒ fail closed，`:124-130`）。
- **重试**：只有引擎自动重试，且被 `maxAttempts` 硬限；handler 的回调被禁止
  （`handlers.ts:35-39` 契约 + `engine.ts:569-576` re-entrancy `CONFLICT`）。
  handler 的整个词汇表只有 `'succeeded' | 'failed' | 'blocked'`（`handlers.ts:24`）。

### 4.3 动态 Task 创建：**当前 production 完全不可达**

`createTask(`（`packages/core/src/domain/task.ts:100`）的全部调用点只在
`packages/core/tests/`、`packages/engine/tests/support.ts:112`、
`tests/support/durable-fixture.ts:119` 与 `tests/sprint14|17/*`。`tasks.put(` 的三处
production 写（`engine.ts:723, 728, 802`）全部是**从 store 读回的同一实体的状态迁移**
（读回在 `:660-664`，缺失 ⇒ `NOT_FOUND`）。`Stage.taskIds` 在 production 永空，
IPC 面（`apps/desktop/src/channels.ts`）零 task 通道，`pack-service.ts` 不创建 Task。

> 结论：**Task provisioning 路径在生产中根本不存在**；`advance()`/`drive()` 只能执行
> 调用方预先给定的 taskIds。这是本 Sprint 最大的结构性缺口（§6 `CORRECTIVE_TASK_PERSISTENCE_GAP`）。

### 4.4 `WorkflowVersion` / `RunSnapshot` 运行期不可变性

- `WorkflowVersion.immutable` 是字面类型 `true`（`packages/core/src/lifecycle/version.ts:31-42`，
  由 `createWorkflowVersion` 硬编码 `:120`），`contentHash` 覆盖
  `{templateId, semver, graph}`（`:111-115`）。
- `RunSnapshot`（`packages/core/src/lifecycle/snapshot.ts:20-35`）pin 七个字段
  （`SnapshotPinnedFields`，`:51-60`）：`orgId / templateId / workflowVersionId /
templateLockId / packVersions / modelBindings / memoryViewRef`；哈希只覆盖这七项，
  **排除 id/timestamp/createdBy**（`:63-72`）。
- 唯一写入点 `lifecycle-service.ts:835`（在 `createRun` 内，`packages/engine/src/lifecycle-service.ts:744-845`）；
  `packVersions` 是 **trusted derived data**，调用方无法提供（`:190-200`，ADR-0027）；
  `modelBindings` 调用方可提供但生产 IPC 路径不传（`apps/desktop/src/workflows.ts:1119-1124`）
  ⇒ 生产快照的 `modelBindings` 恒为 `{}`。
- 三层不可变：应用层无第二个 writer；`applyRunEvent`（`packages/core/src/domain/workflow-run.ts:181-238`）
  只碰 `state/revision/reworkCount/failureReason/resumePoint/history`；SQL upsert 的
  `ON CONFLICT DO UPDATE SET` 明确**不含** `template_id/version_id/snapshot_id`
  （`packages/persistence/src/durable/sqlite-run-store.ts:48-56`）。snapshot upsert 只重写
  `snapshot_hash`，`delete` 直接抛错（`sqlite-lifecycle-stores.ts:239-245, 284-289`）。
- `engine.advance` 对错配快照**抛错**（不返回 err）：`SNAPSHOT_MISMATCH`
  （`packages/engine/src/engine.ts:986-996`），且比较的是 `snapshotId` 字符串而非内容哈希。
- 诚实记录：`verifyRunSnapshot`（`snapshot.ts:134-166`）**production 零调用**，只在
  `packages/core/tests/lock-and-snapshot.test.ts`；事件类型 `run.snapshot_pinned`
  在 L1 `emits` 里声明（`run-state.ts:115`）但引擎从不发射。

### 4.5 既有 Decision / Approval / Handoff 域与 durable 库存

`DurableDatabase`（`packages/persistence/src/durable/index.ts:253-323`）已提供 13 条链，
其中与 Supervisor 直接相关的既有房间：

- **`decisions: DecisionStorePort`**（`:305`）——`DecisionRecord`
  （`packages/core/src/domain/decision.ts:7`）：`decisionId+version` 身份、`scope`、`title`、
  `question`、`decision`、`rationale`、`alternativesConsidered`、`constraints`、`consequences`、
  `status(ACTIVE/SUPERSEDED/REVOKED)`、`provenance.sourceType ∈ {USER, HANDOFF, DECISION,
VALIDATION, WORKFLOW, SYSTEM}`、`relatedArtifactRefs/relatedHandoffRefs/relatedValidationRefs`。
  服务 `packages/engine/src/decision/decision-service.ts`。
- **`approvals: EntityStore<Approval>`**（`:260`）——`Approval`
  （`packages/core/src/domain/approval.ts:28-40`）：`riskLevel`、`status ∈ {pending, approved,
rejected, expired}`、`requestedBy/decidedBy/decisionNote/decidedAt`。
  `requestApproval`（`:52`）拒绝 LOW/MEDIUM（"must not block on human approval"），
  `decideApproval`（`:95`）要求 `run.approve` 且**职责分离**（decider ≠ requester）。
- **`handoffStore`**（`:296`）——`HandoffPacket`（`packages/core/src/domain/handoff.ts:104-145`）
  已带 `objective / summary / completedWork / remainingWork / acceptanceCriteria /
artifactRefs / validationRefs / knownRisks / openQuestions / recommendedNextAction` 与
  结构化拒绝原因码（`:55-65`），且**只有 ACCEPTED handoff 可进 prompt**（`:422-453`）。
- **`ledger: CommandLedgerPort`**（`:262`）+ 指纹回放（`engine.ts:415-436`，
  `packages/persistence/src/durable/sqlite-command-ledger.ts:21`）与条件 UPDATE CAS
  （`sqlite-tool-stores.ts:334-349`）。

### 4.6 Reviewer 输出今天的持久性

- Manifest 只把 reviewer 期望表达为**提示词文本 + artifact kind**
  （`packs/dev-company/src/manifest.ts:239-241`，kind `dev-company:review-report`
  见 `:271-277`），**没有结构化 reviewer verdict/finding 形状**。
- StageHandler 契约无输出字段：`StageHandlerOutcome = 'succeeded'|'failed'|'blocked'`
  （`packages/engine/src/handlers.ts:24`）、`StageExecutionContext`（`:11-22`）无 outputs；
  引擎的成功分支 `step(task,'COMPLETE')` **不传 outputs**（`engine.ts:779`）
  ⇒ `Task.outputs`（`task.ts:85`）在 production 永不被 handler 填充。
- 全仓 production `findings` 结构体**不存在**；最接近的结构化裁决形状都是 validator 侧的
  `DecodedValidatorOutput{verdict,evidenceRefs,report}`（`packages/engine/src/validation/validator-output.ts:23-27`）
  与 `QaEvidenceVerdict`（`packages/engine/src/repository/qa-evidence.ts:64-71`）。
- AgentExecution 只持久化 `resultRef` + `artifactRefs` + usage/latency
  （`packages/core/src/domain/agent-execution.ts:207-233`），**不存 prompt**；
  `inputUsage` 在完成时被硬编码为 0（`packages/engine/src/runtime/agent-runtime.ts:705-710`），
  真实 input tokens 只活在 `agent.provider_invoked` 事件 payload 里（`:642-648`）。

### 4.7 人类升级状态今天的样子

无 `NEEDS_HUMAN` / `escalat*` 词汇（全仓 grep 零命中）。存在的三种耐久形态：

| 形态    | 词汇                                                                                           | 位置                                                   |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Task 级 | `BLOCKED`（仅 RUNNING→BLOCKED→READY）                                                          | `task.ts:47-48`；`engine.ts:695-704` 发 `task.blocked` |
| Run 级  | `WAITING_APPROVAL`（PLANNING/ROUTING/EXECUTING→…；APPROVAL_GRANTED→EXECUTING / DENIED→FAILED） | `run-state.ts:21, 174-193`                             |
| Tool 级 | `WAITING_APPROVAL`（recovery 不自动批准、不自动执行）                                          | `packages/engine/src/tools/registry.ts:815-820`        |

另有 `PAUSED`（`REWORK_EXHAUSTED`：返工超限交 Chief/用户重新决策，`run-state.ts:229-235`），
且 startup recovery 对 `PAUSED / WAITING_* / INTERRUPTED` **只报告不修改**
（`apps/desktop/src/main.ts:594-596`、`packages/engine/src/recovery/startup-recovery.ts:116-124`）。

**关键缺口事实**：`APPROVAL_AUTHORITY = 'run.approve'`
（`packages/core/src/domain/approval.ts:80`）**不在封闭 authority 目录**里
（`packages/core/src/domain/role-authority.ts:16-74`，共 43 个 token，无 `run.approve`、
无 `task.*`、无 `workflow.read`）。因此：任何 role 都**无法通过**
`AuthorizationService.defineRole` → `validateRoleAuthorities` 获得 `run.approve`
（`packages/engine/src/authorization.ts:136-137, 192-193`），生产审批实际依赖
调用方在 `RunCommand.payload.authorities` 里自带的字符串数组
（`engine.ts:392-407`；`drive` 默认 `['run.approve']`，`:880`）。

### 4.8 Crash recovery 语义（Supervisor 必须尊重）

`packages/engine/src/recovery/startup-recovery.ts` 冻结顺序与边界：
agent executions（外部副作用残留先归档）→ tool invocations → workflow runs（`:9-11`）；
**永不重新调用 provider**（`packages/engine/src/runtime/agent-runtime.ts:773`：
"Never COMPLETED, never re-invoked"）；`INTERRUPTED` 是吸收态
（`packages/core/src/domain/agent-execution.ts:53`）；已完成的中断恢复**永不回滚**；
manual 状态只报告；安全失败 ⇒ 启动 fail closed；单飞（`:177-188`）。
task 级 `RUNNING → FAIL → RETRY → READY` 归一化是**惰性**的——只在下次
`executeStageInternal` 执行该 stage 时发生（`engine.ts:715-722`），被打断的 attempt 计入 attempts
（`packages/engine/tests/crash-recovery.test.ts:96-101`）。

## 5. 已冻结契约裁决（RULINGS）

**R1 — Supervisor 不是新的状态机层，也不是第二个 dispatcher。**
Supervisor 只产生 `RunCommand` 与既有领域记录；L1/L3 状态机与 `engine.dispatch` 的
合法性/幂等/revision 检查保持不变。任何"Supervisor 直接改 Task/Run 状态"的设计**违契**。

**R2 — Supervisor 决策落 `DecisionRecord`，不建新表。**
每条决策必须带：`question`、`decision`、`rationale`、`provenance.sourceType='WORKFLOW'`
（监督者自身）或 `'SYSTEM'`、`traceId`、以及与证据的 `relatedArtifactRefs /
relatedValidationRefs / relatedHandoffRefs`。`DecisionStore` 的 `decisionId + version`
不可变历史（`sqlite-memory-stores.ts` 的 `UPDATE ... WHERE status='ACTIVE'`）即为
决策的可审计账本。**禁止**为 Supervisor 新建 decision 表（§2.4）。

**R3 — Run 目标（goal）不得进入 `RunSnapshot` pinned 字段。**
`RunSnapshot` 的 pin 集已冻结（§4.4）且改动它会破坏既有 `snapshotHash` 与历史 run 的兼容。
Run goal 的承载体候选（按优先级）：

1. `Artifact`（kind=`companyos:run-goal` 之类的受控 kind，内容进 CAS，行只有 kind/ref/hash）；
2. `DecisionRecord`（`question=goal`，`sourceType='USER'`）；
3. `ToolInvocation.input` / `Task.inputs`（仅当 goal 由某个工具/任务输入表达时）。
   最终选择由对应 Task 的裁决确定；**任何选择都不得改 schema 或 pin 集**。

**R4 — 纠正动作 ≠ 第三次重试。**
engine 的 `maxAttempts`（默认 3）自动重试保持原样、不被 Supervisor 影响。Supervisor 的
corrective action 必须是**新语义的新记录**：一条 `DecisionRecord` + 一条 run 命令
（或 §7 `CORRECTIVE_TASK_PERSISTENCE_GAP` 关闭后的新 Task provisioning 请求），
而不是把某任务悄悄重试第四次。二者在事件流里必须可区分。

**R5 — Review 与 QA 是两层，不可互替。**

- Review = 独立审查结论（本 Sprint 冻结**结构化评审契约**：verdict + findings + evidenceRefs）。
- QA = ValidationService/validator 工具产生的 `Validation` 行与 EvidenceGuard 的门
  （`evidence-guard.ts`，frozen，ADR-0020）。
- **reviewer verdict 永远不能替代 validation evidence**：EvidenceGuard 只认 durable
  validation batch；review findings 只能作为 artifact/decision 进入证据链。

**R6 — Supervisor 无新 authority（本 Sprint记录，不补）。**
Supervisor 的一切动作都以"已被授权的既有命令 + 既有服务调用"表达。新增 authority
（如 `task.create`、`task.read`、`workflow.read`、`run.approve`）是 §6 的 gap，
**需要 Boss 单独批准后方可在后续 Task 落地**；在批准前，任何 Task 不得向
`AUTHORITIES` 写新 token。

**R7 — Pack 中立性。**
Supervisor 逻辑不得出现任何 pack 名 / 角色名字面量。既有先例：engine 对 `roleId` 全程
按 opaque string 处理，`packages/engine/src/index.ts:5` "It knows nothing about models,
providers, roles or repositories"；`packs/dev-company/src/manifest.ts` 的 role key 形式
（`dev-company:<name>` → materialized `dev-company-<name>`,
`packages/engine/src/pack/pack-service.ts:176`）只属于 pack 层。CTO 角色是否承载监督职责
见 §9 开放问题 Q2——在 Boss 裁定前，**两套方案都不得实现**。

**R8 — 停止条件优先于进度。**
Supervisor 在任一停止条件命中时必须**停止并落 decision**，不得"再试一次"。
停止条件清单见 §11。

**R9 — 幂等与崩溃安全复用既有三件套。**
command ledger 指纹回放（`engine.ts:415-436` + `sqlite-command-ledger.ts:21`）、
条件 UPDATE CAS（`sqlite-tool-stores.ts:334-349`）、每命令一个 UnitOfWork
（`engine.ts:491-533`）。Supervisor 决策身份用确定性 idempotency key
（形态参照既有 `retryIdempotencyKey` / `task-baseline:<runId>:<taskId>` 先例），
**禁止**用随机 id 作为决策键。

## 6. Gap 清单（只记录，不在本 Task 修复）

每个 gap 给：证据（`path:line`）、后果、候选解法、预计关闭 Task。

### G1 `RUN_GOAL_CONTEXT_GAP`

- **证据**：`WorkflowRun` 字段（`packages/core/src/domain/workflow-run.ts:60-89`）与
  `RunSnapshot`（`snapshot.ts:20-35`）都没有 objective/goal/requirement；
  `CreateRunInput`（`packages/engine/src/lifecycle-service.ts:194-200`）只有
  `templateId/companyId/workflowId/modelBindings/memoryViewRef`。
  AgentExecution 不存 prompt（`agent-execution.ts:207-233`）。
- **后果**：Supervisor 无法知道"这个 run 为什么存在"，任何目标符合性判断都无基准；
  用户的目标只活在进程内存与 IPC 报文里，重启即失。
- **候选解法**：R3 的承载体裁决（artifact/decision/Task.inputs 之一）。
- **关闭**：T18-02（提案）。

### G2 `SUPERVISOR_DECISION_PERSISTENCE_GAP`

- **证据**：`DecisionStore`/`DecisionService` 存在且能力完备（§4.5），但
  **production 零调用方**——没有任何应用服务写 `DecisionRecord`；事件类型
  `decision.created` 甚至不在 `CORE_DOMAIN_EVENT_TYPES`
  （`packages/core/src/domain/event.ts`），只由服务自带 `DecisionAudit` 发射。
- **后果**：决策域是"空房间"：有表、有契约、无写者。Supervisor 若无写者即无账本。
- **候选解法**：Supervisor 服务作为第一个 production 写者，经 `decision.create`。
- **关闭**：T18-03（提案）。

### G3 `REVIEW_FINDING_DURABILITY_GAP`

- **证据**：§4.6 全节。handler 无输出字段（`handlers.ts:24`），成功分支不传 outputs
  （`engine.ts:779`），manifest 只有提示词文本（`manifest.ts:239-241`）。
- **后果**：Reviewer 结论不可机读、不可门禁、不可被 Supervisor 引用；
  "审查通过" 无法与 durable evidence 绑定。
- **候选解法**：冻结结构化 review envelope（verdict + findings[{id, severity, title,
  evidenceRefs}] + summary），作为 artifact kind 与（未来的）handler 输出载体。
- **关闭**：T18-04（提案）。注意：handler 输出载体扩展**会改动 engine 契约**，
  必须单独批准。

### G4 `CORRECTIVE_TASK_PERSISTENCE_GAP`

- **证据**：§4.3。`createTask` production 不可达；`Stage.taskIds` 永空
  （`stage.ts:104`）；`tasks.put` 只做既有实体迁移（`engine.ts:723/728/802`）。
- **后果**：**纠正动作无法表达为"新任务"**。Supervisor 目前只能重发既有 run 命令
  （retry/cancel/approval 之类），无法说"基于这次发现，新增一个修复任务"。
  这是 Sprint 18 的**核心能力缺口**，也是最高风险项。
- **候选解法**（三选一，需 Boss 裁定，见 §9 Q1）：
  1. 授权一个受控 provisioning 服务：新 `task.create` authority + 只允许向**当前 run 的
     非终态 stage**追加 PENDING task + 确定性 id + 单事务；
  2. 表达为 WorkflowVersion 新 graph 节点（重跑 design-time 全链）——过重、且与
     "有限微调，不每次从头发明" 原则冲突；
  3. V1 不提供 corrective task：Supervisor 只能重发既有命令 + 落 decision + 升级人类。
- **关闭**：T18-05（提案，**前提是 §9 Q1 已裁定**）。

### G5 `HUMAN_ESCALATION_STATE_GAP`

- **证据**：§4.7。三种耐久等待形态都在，但 `run.approve` 不可经由 role 授予
  （`role-authority.ts:16-74` 无该 token；`authorization.ts:136-137` 会拒）；
  decision/approval/handoff 之间没有统一的"升级"语义；`approval.expired` 发射者
  仍是未建的 sweeper（`event.ts:205`）。
- **后果**：Supervisor"交还人类"只能拼装既有原语，且审批授权模型与角色模型脱节。
- **候选解法**：定义 escalation = `DecisionRecord(status=ACTIVE, question=…)` +
  `Approval(pending)`（必要时 + `Handoff(READY)`），权威token问题单独提 Boss。
- **关闭**：T18-06（提案）。

### G6 `SUPERVISOR_AUTHORITY_GAP`

- **证据**：§4.7 封闭目录 43 token，无 `task.*` / `workflow.read` / `run.approve`；
  `decideApproval` 靠调用方自带 authorities（`approval.ts:88`、`engine.ts:392-407`）。
- **后果**：Supervisor 的"读面"（读 task/run/decision）没有对应 authority 可授；
  审批决定无法通过角色模型获得。**这是治理层缺口，不是实现层缺口。**
- **候选解法**：Boss 裁定后新增 token（违反 §2.5 的默认禁令，须显式批准）；
  或维持"Supervisor 是 main-process 受信组件，不经 authority 面"的立场
  （与 Sprint 13 Task-13-11 corrective 的 trusted main-process 边界一致）。
- **关闭**：T18-01 记录；实现由 Boss 裁定后另立 Task。

### G7（recon 新增）`HANDLER_OUTPUT_CARRIER_GAP`

- **证据**：`handlers.ts:11-39`（无 outputs）、`engine.ts:779`。Task.outputs 字段存在
  （`task.ts:85, 139-141` 合并逻辑）但 production 无填充者。
- **后果**：任何"handler 产出结构化结论"的能力（不止 reviewer）都缺载体。
- **关闭**：与 G3 同一 Task，同一批准。

### G8（recon 新增）`SNAPSHOT_VERIFY_PRODUCTION_GAP`

- **证据**：`verifyRunSnapshot`（`snapshot.ts:134-166`）production 零调用；
  `engine.advance` 只比 `snapshotId` 不比内容哈希（`engine.ts:986-996`）。
- **后果**：快照内容被篡改时运行期不会发现（有 `snapshot_hash` 列却不校验）。
- **候选解法**：在既有 `advance`/`drive` 路径补一次 `verifyRunSnapshot`（读-only，fail closed）。
- **关闭**：T18-02 或独立 corrective（**不得**与 Supervisor 功能混淆提交）。

### G9（recon 新增）`MODEL_BINDING_RUN_PINNING_GAP`

- **证据**：`RunSnapshot.modelBindings` 生产恒 `{}` 且零读者（§4.4）；
  `selectModel` 每次执行重新解析并**拒绝静默换模型**
  （`agent-runtime.ts:479-491`）。
- **后果**：Supervisor 若要做成本/模型一致性判断，没有 run 级绑定基准；
  DevCompany 的 `reviewerMustDifferFromDeveloper`（`packs/dev-company/src/model-policy.ts`）
  无 production 消费者。
- **关闭**：本 Sprint **不关**（列入 V1 limitations，§13）。

## 7. Decision 语义（冻结）

一次 Supervisor decision 的完整形状（映射到 `DecisionRecord`）：

| 决策要素               | 承载体                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| 触发上下文（看到什么） | `provenance.sourceRefs`（run/stage/task/artifact/validation/handoff ids） |
| 问题                   | `question`                                                                |
| 结论                   | `decision`                                                                |
| 理由                   | `rationale`                                                               |
| 被否方案               | `alternativesConsidered`                                                  |
| 后果/约束              | `consequences` / `constraints`                                            |
| 证据                   | `relatedArtifactRefs` / `relatedValidationRefs` / `relatedHandoffRefs`    |
| 身份与时间             | `decisionId`（确定性幂等键派生）+ `version` + `decidedAt`                 |
| 责任主体               | `decidedBy`（受信组件标识，不是随机 id）                                  |
| 追溯                   | `traceId`                                                                 |

决策种类（closed set，V1）：`OBSERVE`（只记录）、`RETRY_REQUEST`（交由既有引擎重试语义）、
`ESCALATE`（§10）、`STOP_RUN`（触发 `run.cancel` 语义，经既有命令面）、
`NOTE`（经验/教训，可入 memory，`memory.create` 仅当被授权时）。
**V1 不包含 `CREATE_TASK`**（依赖 §9 Q1 裁定）。

## 8. Corrective 语义（冻结）

1. corrective 只能经**既有命令面**表达：`RunCommand` → `engine.dispatch`
   （合法性、revision、幂等、ledger 全部照旧生效）。
2. corrective 触发前必须已有：a) 一条 durable decision（R2）；b) 证据引用非空
   （artifact/validation/handoff 至少一项，或显式 `OBSERVE`）。
3. corrective 不得绕过 EvidenceGuard：任何"再跑一次验证"的意图都必须经 validator 工具
   与 validation 记录，不得由 Supervisor 自行判定通过。
4. corrective 的每次外部可观察动作必须带确定性 idempotency key（R9）；
   重复触发 = ledger 回放同一结果，不产生第二次副作用。
5. corrective 失败（命令被拒/非法转换/预算耗尽）必须落 decision 并进入 §11 停止评估，
   **不得**自动升级为更强动作。

## 9. 开放问题（必须 Boss 裁定；未裁定前对应能力不得实现）

- **Q1 — corrective task 载体**：G4 的三选一。我的建议：**选项 1（受控 provisioning +
  新 authority）**，因为它最贴近"纠正"语义且不动 workflow 版本链；但它违反 §2.5 默认禁令，
  必须显式批准。选项 3 是零风险降级方案。
- **Q2 — Supervisor 与 CTO 的关系**：reuse `dev-company:cto`（省一个角色，但把行业角色
  绑进通用引擎语义，违反 R7）vs 新增 pack 中立 role（需改 manifest，违反 §2.7）。
  **建议：V1 两者都不绑**——Supervisor 以 main-process 受信组件身份运行，不为它分配 pack 角色；
  CTO/角色问题留在 DevCompany 包层单独 Task。**注意：本项与 roadmap `Sprint 18：CTO Workflow`
  段（`docs/EXECUTION_ROADMAP.md:834-854`，来源规划书 §五十八/§五十九）是两份不同规划；
  本契约只覆盖已批准的 Autonomous Supervisor & Corrective Loop。roadmap 段是否改写 /
  两份如何并存，需 Boss 裁定（本 Task 不改 roadmap）。**
- **Q3 — `run.approve` 与 authority 目录**：是把 `run.approve` 补进 `AUTHORITIES`
  （一行改动，但改变封闭目录语义），还是维持"审批授权走命令 payload"现状？
  建议：**本 Sprint 维持现状并记录**，任何目录变更单独 ADR。
- **Q4 — ADR-0029 是否需要落文件**：本 Task 只在 §12 记录候选决定文本。若 Boss 认为
  "Supervisor 职权边界"已构成 Accepted 级决策，再落 `docs/adr/0029-*.md`（Proposed 起步）。

## 10. 人工升级语义（冻结）

- 升级 = 一组既有原语的组合，**不发明第四种等待状态**：
  1. 一条 `DecisionRecord`（question=为什么升级、decision=交还人类、rationale=卡在哪）；
  2. 一个 `Approval`（`pending`，风险等级按 `requestApproval` 规则，LOW/MEDIUM 会被拒）；3.（可选）一个 `HandoffPacket`（READY，携带完成/剩余工作与验收标准）。
- 升级后 Supervisor 必须停止对该 run 的自动动作，直到 approval 被 `decidedBy ≠ requestedBy`
  的人类决定（职责分离，`approval.ts:116-123`）。
- Task `BLOCKED` 是"这个任务等人类"的表达；run 级 `WAITING_APPROVAL` 是"这个 run 等人类"。
  Supervisor 必须显式选择其一，不得两者同时置位后不解释。
- recovery 不得自动解除升级状态（沿用 `startup-recovery.ts:116-124` 的
  "manual states are reported, never mutated"）。

## 11. 停止条件（冻结，全部 fail closed）

Supervisor 在任一条件命中时停止并落 decision：

1. **预算耗尽**：task `attempts >= maxAttempts`（`engine.ts:792-796`），或 run `PAUSED`
   （`REWORK_EXHAUSTED`，`run-state.ts:229-235`）。
2. **证据缺失/过期**：EvidenceGuard 任一 fail-closed 理由（`evidence-guard.ts`：
   `VALIDATION_GATE_NO_EVIDENCE / NO_REQUIREMENTS / NO_ELIGIBLE_BATCH / INCOMPLETE /
EVIDENCE_INVALID / POLICY_MISMATCH / FAILED`）。
3. **快照/版本不匹配**：`SNAPSHOT_MISMATCH`（`engine.ts:986-996`）、模板缺失、
   pinned version 不可解析（`artifact-stack.ts` 的 `GATE_*` 四级失败）。
4. **run 非执行期**：run 状态不在执行集合内（`run-state.ts:89-98`），或已终态。
5. **升级未决**：存在 `pending` approval 且 `decidedBy === null`。
6. **恢复进行中**：run 处于 `RECOVERING` / startup recovery 单飞未完成
   （`startup-recovery.ts:177-188`）。
7. **决策键冲突**：ledger 指纹不匹配（`CONFLICT`，"Idempotency key reused with different
   content"，`engine.ts:415-436`）——这表示两次"同一决策"内容不同，必须停。
8. **未知状态**：任何无法映射到上述分类的情况 ⇒ 停在 `OBSERVE` 并升级。

## 12. 幂等 / 崩溃恢复 / 与各子系统的交互（冻结）

| 子系统                | Supervisor 的交互规则                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkflowEngine        | 只经命令面；不读不写 Task/Run 状态；`advance`/`drive` 的既有校验照旧                                                                                    |
| CommandLedger         | 决策与 corrective 的确定性键 + 指纹；冲突 ⇒ 停止条件 7                                                                                                  |
| UnitOfWork            | 一个决策 + 其副作用一个事务（沿用 `engine.ts:491-533` 模式）                                                                                            |
| Artifact / Validation | 只读既有证据；写入只经既有 ArtifactService（`artifact.create`）与 ValidationService（validator 工具调用）；**不改** EvidenceGuard                       |
| Repository Runtime    | 只消费其 durable 证据（QA evidence verdict、anchor、tool invocation 失败证据）；**不直接 spawn/读写/git**（§2.10）                                      |
| AgentRuntime / Model  | 无新 provider；监督推理若需模型，经 `AgentRuntime` 且必须显式 `modelKey`（`MODEL_SELECTION_REQUIRED`，`agent-runtime.ts:308-318`）；Router 只推荐不执行 |
| Recovery              | 尊重 `startup-recovery.ts` 全部冻结条款；Supervisor 自身的半成品决策靠 ledger/决策键幂等重入，**不得**在恢复中被重新执行副作用                          |
| Pack                  | 中立（R7）；不改 manifest、不改 pack 框架                                                                                                               |
| Persistence           | 无新表、无 migration（§2.4）                                                                                                                            |

## 12.5 执行上下文（T18-02 已落地，ADR-0029 末节）

三个可信事实已可 durably 取得，全部复用既有持久化原语（零 migration / 零 schema 变更 / 零新表）：

| 事实                           | 承载                                                                                    | 检索                                                | 不变量                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run Goal（WHAT）               | run-owned immutable Artifact，kind `companyos:run-goal`（Core `lifecycle/run-goal.ts`） | `RunGoalService.get({runId, companyId})`            | 与 run 同事务写入；`run-goal:<runId>` 寻址；无 latest 回退；company/run/kind 逐层校验；不可覆盖（第二次写入 ⇒ artifact 指纹 `CONFLICT`）；同 `commandId` 重放同一 goal，异内容 ⇒ ledger `CONFLICT` |
| RunSnapshot 完整性（WHAT NOT） | Core `verifyRunSnapshot`，经 engine `runSnapshotVerifier` seam                          | `createRunSnapshotVerifier({templates, snapshots})` | 每个 stage 执行前证明 pin；缺失/篡改/模板或版本缺失 ⇒ fail closed；无 repair/update/重生成                                                                                                         |
| Model binding（WITH WHAT）     | `RunSnapshot.modelBindings`（Core `lifecycle/run-model-bindings.ts` 校验）              | `createRunModelBindingReader`                       | 受信 application 配置；未知/禁用/不可用 ⇒ fail closed；无默认、无 latest；run 创建后不可变                                                                                                         |

边界说明（诚实记录）：production IPC 尚未提交 goal（本 Sprint 不做 UI/IPC），因此生产创建的 run 暂无
goal，`getRunGoal` 对其 fail closed —— 这正是"不许猜"的语义。model binding 读取侧目前**没有 production
消费者**（Supervisor 尚未存在）；接缝已 fail closed 就绪，绑定留给 T18-05/06。

## 12.6 永久幂等且 tenant-scoped 的 Decision 身份（T18-03 冻结 + corrective）

Supervisor decision 的永久身份**不依赖** bounded command ledger，且**是 tenant-scoped 的**：
`command_ledger.command_id` 虽是全局 PRIMARY KEY，但它有界可 trim、且 decision sink 从不写 ledger，
所以 decision 的 command identity 没有任何地方被强制全局唯一。

```
trusted command identity
  → decisionId = dec_ + sha256("companyos/supervisor-decision/1:" + companyId + ":" + commandId)[0:26]
  → PRIMARY KEY(decision_id, version)                      ← 永久唯一（含 tenant）
  → fingerprint ∈ DecisionRecord.metadata
      （companyos/supervisor-decision/1；companyId 开头，覆盖 commandId/runId/stageId/taskId/
        action/reasonCode/summary/sorted evidenceRefs/binding 身份）
```

同 tenant + 同 identity + 同 fingerprint ⇒ 原样回放；同 identity + 异 fingerprint ⇒ `CONFLICT`；
并发与崩溃重试收敛到同一行（ledger trim 后仍然成立）。跨 tenant：同 commandId 得到不同 decisionId
（无 PK 冲突），且 run 归属检查先于任何 decision 访问，返回与"不存在"不可区分的 `RUN_MISSING`。

**读者语义**：`listRunDecisionHistory(companyId, runId)` = 全 status 历史（ACTIVE/SUPERSEDED/REVOKED，
tenant-first 过滤，`decidedAt → decisionId → version` 确定性排序）；`listActiveRunDecisions` 是显式命名的
ACTIVE-only 查询。recovery/audit 读者永不等于 active-only。

**证据契约**：所有 ref 经既有 durable resolver 校验（`artifact:art_…` / `art_…` / `val_…` 是既有合法语法，
`toolinvocation:` / `validation:` / `supervisor:` 一律拒绝），但只有 kind='artifact' 才写进
`relatedArtifactRefs`（`val_<id>` 不是该字段的合法值）；每个 ref 的 resolved kind 记录在 payload seam 中，
QA provenance 引用 T17-06 的 validator report Artifact。

Record-only：sink 只写 decision 行，不执行任何状态变更、不建 Task、不建 approval、不通知。

## 12.7 Review Findings（T18-04 冻结）

**Review is semantic evidence, not QA.** Reviewer 结构化产出 = run-owned 不可变 Artifact
（kind `companyos:review-findings`，schema `companyos/review-findings/1`），经受信 sink 写入：

- verdict 词表 `PASS | CHANGES_REQUESTED | BLOCKED`；PASS 只表示 reviewed scope 内无 blocking
  语义发现，**不产生 Validation、不进六个 QA evidence slots、不放行 EvidenceGuard**。
- finding：`findingId` / `fingerprint` 系统派生（语义字段 + sorted refs；不含 createdAt、随机 id、
  数组顺序）；同 report 内语义重复去重；bounds 已冻结（max 64 findings / summary 2000 /
  detail 8000 / 16 refs per finding / locator 400）。
- 永久幂等：tenant-scoped command identity；同一逻辑 review execution ⇒ 一份 canonical report
  （ledger trim 后仍成立），同 execution 异内容 ⇒ `CONFLICT`；新 execution ⇒ 新 report，旧报告永久保留。
- 读者：`listReviewHistory`（全历史，按 execution 派生 `reviewAttempt` → `createdAt` → `artifactId`
  确定性排序）与 `getLatestReviewReport`（latest report，**不是 latest PASS**）。
- **执行身份（corrective 冻结）**：`executionId` 必填；`reviewAttempt` / `agentId` / `roleId` /
  binding **全部从 AgentExecution 行派生**（caller 不得提供 `reviewer` / `reviewAttempt` /
  `agentId` / `roleId`）；execution 必须属于本 run 与本 review task，且 status 为 `COMPLETED`；
  **无 TASK_ATTEMPT 退化通道**。
- **模型 provenance（corrective 冻结）**：从 execution 实际 binding 派生，并证明该 modelKey 确被
  本 run pin；声称的 binding 名若不是 execution 实际使用者 ⇒ 拒绝（"模型被 Run 允许"不再足够）。
- 证据：只用既有 `artifact:art_…` / `art_…` / `val_…` 语法；validation 身份不写成 artifact ref；
  QA provenance 引用 T17-06 validator report Artifact。
- 读取边界由 company + run + payload 结构性校验承担（`artifact.read` 为保留词，无运行期强制点）。

## 12.8 Corrective Task Provisioning（T18-05 冻结）

**Corrective = runtime execution work item，不是 workflow 定义变更。** Frozen WorkflowVersion /
RunSnapshot / stage graph / Pack manifest 零改动；新 work item 落在既有 Task 域（tasks 表、
`PENDING, attempts=0`），落在 original work task 所属 stage。

- **唯一触发器**：durable、ACTIVE、**current version** 的 `REQUEST_CORRECTIVE` Decision
  （T18-03 sink 记录）。跨 company / 跨 run / 其他 action / REVOKED / 非当前 version ⇒ 拒绝。
- **永久身份**：`tsk_ + sha256(companyos/corrective-task/1 + companyId + runId +
originDecisionId + originDecisionVersion)` 的前 26 位 —— tenant-scoped，一个 Decision version
  至多一个 corrective task（ledger trim 后仍成立，因为 tasks 表 upsert 不覆写 inputs_json）。
- **lineage**：`Task.inputs.corrective`（versioned `companyos/corrective-task/1`）携带
  originDecisionId/version、reasonCode、parentTaskId、rootTaskId、round、causeEvidenceRefs、
  fingerprint。round 由祖先链派生，caller 不可提供。
- **cause 词表 V1**：`REVIEW_FINDING`（latest actionable review report，parent = subjectTaskId）、
  `VALIDATION_FAILED`（latest QA report，parent 由 tool invocation taskId 解析）；
  `TASK_FAILED` / `TOOL_FAILED` 拒绝。
- **只创建不执行**：无 AgentExecution、无 repo baseline、无 ToolInvocation、无 Validation、
  无 Review Report、无自动 Decision；何时执行由 T18-06/T18-07 决定。
- **无 max round 执行**（属 T18-07 停止条件）。

## 12.9 Supervisor Decision Runtime（T18-06 冻结）

**一次有界 turn，不是一个循环。** `runOneSupervisorDecisionTurn` 的顺序被冻结，且每一步都可被
同一个 AbortSignal + 同一个 deadline 取消：

```
load Run（company 校验）→ load canonical Goal → verifyRunSnapshot → resolve pinned binding
→ build bounded SupervisorContext → prepare durable AgentExecution → invoke model ONCE
→ 严格解析 proposal → 语义前置校验 → T18-03 sink 落 Decision → complete AgentExecution
```

- **binding 唯一来源**：`RunSnapshot.modelBindings[supervisorBindingKey]`（受信应用配置，
  默认 `supervisor`）。未知名 ⇒ `RUN_BINDING_MISSING`；模型记录消失 ⇒ `RUN_BINDING_UNKNOWN`；
  禁用/不可用 ⇒ `RUN_BINDING_UNUSABLE`。**零模型调用、零 Decision。**
- **无 Goal ⇒ 无 context ⇒ 无 turn**（`RUN_GOAL_MISSING`，fail closed）。
- **snapshot 不可证明 ⇒ 零模型调用、零 Decision**（tamper ⇒ `SNAPSHOT_MISMATCH`）。
- **SupervisorContext 有界投影**（非 chat history）：goal objective、run/pinned 版本、subject
  task、corrective lineage 投影、**latest** review report（anti-cherry-pick，非 latest-pass）、
  **latest** validation（newest wins）、有界 decision history、binding、blocking conditions、
  refs、truncated 列表。渲染超 16 KiB ⇒ `SUPERVISOR_CONTEXT_TOO_LARGE`（拒绝，不静默截断）。
- **提案契约 `companyos/supervisor-proposal/1`**：`decodeSupervisorProposal` 严格结构解码
  （schema / 五个键 / action ∈ 4 / reasonCode ∈ 7 / 有界 summary / evidenceRefs ≤ 32 /
  subject={taskId}）。**无子串提取、无 JSON 修复**；模型若只回散文 ⇒ INVALID_OUTPUT。
- **语义前置校验**（prompt 之外的第二道真实闸门）：action↔reasonCode 封闭配对表；
  CONTINUE 不得在有 blocking condition 时成立；ESCALATE 必须有 blocking condition；
  COMPLETE 必须 subject task `DONE` **且** latest validation `pass` 且引用该 validation；
  REQUEST_CORRECTIVE 必须 `REVIEW_FINDING`（latest review `CHANGES_REQUESTED` 且被引用）
  或 `VALIDATION_FAILED`（latest validation 失败且被引用，或其自身引用的 artifact）；
  proposal 不得针对非 subject task。
- **执行语义**：Decision 经 T18-03 sink 写入后才允许 `completeExecution`（§45）。
  `resultRef` 保持为 null：它是 Sprint 13 冻结契约里的**不透明字符串**（无 canonical Decision
  ref grammar，仓库里唯一能解析 `decision:<id>@<version>` 的代码就是 T18-06 自己写的）⇒
  T18-06 corrective 已**移除**该自造 namespace，两条耐久行的关联改用**双方都已有的
  `traceId`**（`AgentExecution.traceId === DecisionRecord.traceId`）。
  usage 用 provider 实际报告值（不清零）；解析/语义失败 ⇒ `failExecution(INVALID_OUTPUT)`，**零 Decision**。
- **结构上无 tool**：不声明 tool descriptors、不跑 tool round、本模块不依赖 tool registry，
  模型看不到任何工具（不是 prompt 规则）。
- **取消真实传播（T18-06 corrective，关闭 `PROVIDER_ABORT_CONTRACT_GAP`）**：
  `InvocationRequest.signal?: AbortSignal`（Core `ports/model-provider.ts`，optional ⇒ 未提供的
  调用方行为逐字不变）。signal 从 SupervisorDecisionRuntime → AgentRuntime →
  ProviderRegistry → adapter → 模型调用真实传播，**不存在 `Promise.race` 伪装取消**：
  - commit 前取消 ⇒ **零 provider 调用**（AgentRuntime 在调用前硬门）；
  - 飞行中取消 ⇒ adapter 观察到 signal 并终止该次调用，Attempt 以
    `FAILED(error_kind=CANCELLED, error_code=CANCELLED)` 终态（终态非成功，分类明确、**不可重试**）；
  - adapter 既不重试、不回退到别的 provider/model（same pinned model only）；
  - 正在 backoff 的重试观察到 abort ⇒ 不再发起下一次 attempt；
  - commit 后取消 ⇒ Decision 已耐久，同 identity retry 幂等（零模型调用、零第二条 Decision）；
  - 取消在 ProviderRegistry 内**不被重新分类**成 `AGENT_UNAVAILABLE`（那是把取消伪装成可重试的
    provider 故障），以 `CANCELLED` 原样上抛并审计 `provider.cancelled`。
- **无本 Task 之外的能力**：无 loop、无 `maxCorrectiveRounds`、不调用 Corrective Provisioner、
  不 drive/advance、无审批/人工状态、无 IPC/UI、无 shell/hook。

## 12.10 Bounded Autonomous Supervisor Loop（T18-07 冻结）

**一次有界编排周期，不是一个常驻循环。** `runAutonomousSupervision` 的顺序被冻结：

```
guard(abort + deadline) → 读 Run（WAITING_APPROVAL / terminal / CANCELLED 执行 ⇒ 停）
→ T18-06 Supervisor turn（唯一模型路径）→ Decision Applicator（受信）→ 效果
→ durable 进展指纹 → 下一个合法工作单元 → 下一 turn → … → COMPLETE / ESCALATE / 停止
```

- **单一事实**：编排器只经 canonical service 读写；不自持 Task/Run/Decision 状态、retry ledger、
  workflow graph。唯一持久物是 application receipt artifact（`companyos:supervisor-application`），
  命令身份 `supervisor-application:<runId>:<decisionId>@<version>` ⇒ 一个 Decision 版本
  **永远一次效果**（ledger trim / restart / 并发都收敛到同一 receipt）。
- **上界**：`maxSupervisorTurns = 20`、`maxCorrectiveRounds = 3`（Boss V1 裁定，受信应用配置）。
  计数器在每轮**之前**检查；无 `while(true)`；迭代非递归。
- **round 上限位置**：T18-05 provisioner 的 `provision` 内（派生 round 之后、构造 Task 之前）
  ⇒ 直接调用 provisioner 也无法绕过；超过 => `CORRECTIVE_ROUND_LIMIT_EXCEEDED` 且零 Task。
- **CONTINUE = 恰好一个合法工作单元**：下一个工作单元由 run 的 PINNED 版本图（拓扑序 + nodes
  数组序 tie-break）与 Task 行推导（task.stageId 属于 pinned 节点集且有非终态 task）。不猜 stage
  名、不读 pack 数据、不用 conversation 状态。
- **Decision -> action 映射**（Applicator，全部 canonical service）：
  - CONTINUE -> `engine.advance({runId, stageId, taskIds, snapshot})`（一个原子 stage 单元）；
  - REQUEST_CORRECTIVE -> T18-05 provisioner -> `engine.advance`（该 corrective task）；
  - COMPLETE -> `engine.dispatch(DELIVERY.COMPLETE)`，仅在 run 为 FINALIZING/COMPLETED 时合法，
    且应用前**重读**完成证据（TOCTOU 防护）；
  - ESCALATE -> `engine.dispatch(APPROVAL.REQUEST)`（riskLevel 来自受信配置）。
- **人工升级 = 既有耐久接缝**：pending `Approval` + `Run.state = WAITING_APPROVAL`。从该状态没有
  合法 run 事件能继续工作（stage 事务内的 `EXECUTION.COMPLETE` 等均非法，整体回滚）=> restart
  后仍成立且机器可读。`resumeEscalatedRun` = 一次 `APPROVAL.GRANT`，authority 由受信调用方提供
  （与 engine driver 同一方式），**不新增 token**；decider 不等于 requester 由 `decideApproval`
  强制；无 pending => `AUTONOMOUS_RESUME_NOT_WAITING`。
- **TOCTOU / anti-stale**：Applicator 只应用 **current ACTIVE** Decision 版本；superseded/revoked
  => `AUTONOMOUS_DECISION_NOT_CURRENT`；provisioner 在 apply 时**重新解析** cause => review 或
  validation 在窗口内变化即被拒（`CORRECTIVE_CAUSE_REPORT_SUPERSEDED` 等）。
- **无进展检测**：指纹 = run.revision + run.state + 全部 task `id:state:attempts` + 已应用
  decision id（只用身份，不做语义相似度）；连续 `maxIdleTurns` 次无变化 => fail-closed 停止。
- **取消**：一个 AbortSignal + 一个 deadline 覆盖整个 run（含每个 turn、engine 与 provider）；
  提交前取消 => 零效果；已提交的 durable 状态保留，不启动新动作；`CANCELLED` 执行是终态非成功，
  编排器在 turn 之前检查并停止——**绝不进入自动重试**。
- **不扩张**：无并行 agent、无 subagent、无 IPC/UI、无新 authority/Tool/表/migration；Supervisor 的
  模型调用仍零 tool；repository 安全面零改动。

## 12.11 Stage Output Carrier & Evidence→Lifecycle（T18-07 corrective 冻结）

**权威链**（Boss §31）：`AgentExecution → StageHandler 结构化 output → Task.outputs →
canonical Review/Validation sink → trusted evidence applicator → canonical Run lifecycle →
Supervisor 下一 turn`。**不是** `model prose → Run transition`。

- **StageHandlerOutcome 拓宽**（Core `lifecycle/stage-output.ts`）：`{ status, output? }`，其中
  `output` 是 versioned `companyos/stage-output/1` 信封（kind / executionId / artifactRefs /
  validationRefs / 有界 payload）。裸状态字符串仍然合法——**一个**归一化边界
  （`normalizeStageHandlerResult`）把两者汇成同一种规范形式，引擎自此只认一种。
- **Task.outputs 成为耐久载体**：引擎在把 task 迁到 DONE 的**同一个 step** 里写入信封，
  因此"Task DONE 但载体缺失"在事务内不可能出现。信封**不得**携带整段模型 transcript、
  raw stdout blob、无界 source 或作为权威的任意散文。
- **身份不可伪造**：信封的 executionId 由 carrier 对照 durable AgentExecution 行校验
  （存在 / 同 run / 同 task / 已 COMPLETED）；不通过 ⇒ 拒绝写入 sink。
- **carrier（engine `supervisor/stage-output-carrier.ts`）**：reviewer 候选 → T18-04
  ReviewFindingsSink（`companyos:review-findings` artifact 的唯一写者）；QA 候选 → T17
  canonical ValidationService（Validation 行的唯一写者）。无第二写者、无散文解析、
  无 `"PASS"` grep、无 JSON 子串提取。QA 的六个证据槽与 current-anchor 语义沿用既有
  validator 路径，不改写。
- **evidence applicator（engine `supervisor/evidence-lifecycle.ts`）**：canonical 证据蕴含
  恰好一个合法 Run 事件——REVIEWING + latest review PASS ⇒ `REVIEW.PASS`；CHANGES_REQUESTED/
  BLOCKED ⇒ `REVIEW.REJECT`（→ REWORK）；VALIDATING + latest validation 满足 ⇒
  `VALIDATION.PASS`（→ FINALIZING）；失败 ⇒ `VALIDATION.FAIL`（→ REWORK）。事件 gate 所需的
  anchors（artifactId/stageId）从 durable validation 行派生，绝不来自调用方或模型。
  应用前重读 latest review / latest validation / Run 状态（TOCTOU）。
- **pinned agent execution（engine `supervisor/pinned-agent-execution.ts`）**：自主执行路径
  唯一模型入口——`RunSnapshot.modelBindings[bindingKey] → ModelRegistry → AgentRuntime`，
  方法面**没有任何** model 身份参数可供覆盖；缺失/未知/禁用/不可用 ⇒ fail closed，
  零 provider 调用；无 alternate provider / model / fallback binding。
- **round cap 与上界不变**：`maxCorrectiveRounds = 3`、`maxSupervisorTurns = 20`。

## 12.12 Decision Application 崩溃窗口（T18-07 corrective 冻结）

receipt 写在 action **之后**，因此单靠 receipt 的永久 commandId 不构成 exactly-once。每个
action 必须**各自**用永久身份自证幂等（§36–§40）：

- **CONTINUE**： durable Task 状态是权威——派生工作单元已全部终态 ⇒ 这是 application replay，
  直接补写 receipt，不再执行任何工作（不会第二次跑 tool/agent）。
- **REQUEST_CORRECTIVE**：T18-05 永久 corrective Task 身份（run + decisionId + version）即
  幂等证明；provisioner 回放命中既有 task ⇒ 记为 replayed，不再执行 stage。
- **ESCALATE**：run 已是 WAITING_APPROVAL ⇒ 已有且仅有唯一 pending Approval，补写 receipt，
  绝不请求第二个 Approval。
- **COMPLETE**：run 已 COMPLETED ⇒ 不派发第二次（非法）迁移，补写 receipt。
- **terminal 收尾**：run 已 COMPLETED 而某 Decision 的 receipt 缺失时，从 durable decision
  history 读取并补写其 receipt（纯记账，不派发、不执行）。
- 上述窗口由注入式 checkpoint 测试证明（不使用 wall clock，不建 fault-injection 框架——

> **Sprint 18 closeout note (T18-09)**: the list in §13 is a T18-06-era snapshot and is
> superseded by `S18_CLOSEOUT.md` — the final gap board. In particular
> `GENERIC_AGENT_PINNED_MODEL_CONSUMER`, `MODEL_BINDING_EXECUTION_CONSUMER_GAP`,
> `HUMAN_ESCALATION_STATE_GAP` and `HANDLER_OUTPUT_CARRIER_GAP` are CLOSED as of the Sprint 18
> closeout (see the closeout document for the proof references).
  T18-08 的职责）。

## 13. V1 Limitations（冻结声明）

**截至 T18-06 已落地并关闭**：run goal 落盘（T18-02）、supervisor decision 账本（T18-03）、
结构化 review findings（T18-04）、controlled corrective task provisioning（T18-05，只创建不执行）、
Supervisor decision runtime（T18-06，一次有界 turn，只记录不执行）。

1. **无 autonomous loop 本体**（无调度器；Supervisor 只被既有入口调用；何时执行 corrective
   task 属 T18-06/T18-07）。
2. **无 max corrective round 执行**（round 已记录，停止条件属 T18-07）。
3. **无货币成本核算**（production 无 cost 落盘；usage 只有 event payload 与
   `outputUsage`，见 §4.6）。
4. **run 级 model binding 执行消费三元状态**（`MODEL_BINDING_EXECUTION_CONSUMER_GAP`）：
   - `SUPERVISOR_PINNED_MODEL_CONSUMER` = **CLOSED**（T18-06：`supervisor-binding` 只从
     `RunSnapshot.modelBindings` 解析，seam = `supervisor-runtime.ts` 的
     `modelBindings.resolve(...)`）。
   - `GENERIC_AGENT_PINNED_MODEL_CONSUMER` = **OPEN**（通用 `AgentRuntime.prepare` 仍接受
     调用方直接给出的 `modelKey`，seam = `agent-runtime.ts` 的 `selectModel`；run 级 pin 尚未
     成为该路径的唯一来源）。**不得因为 Supervisor 已 pin 就宣称通用 Agent 全部 pinned。**
   - `MODEL_BINDING_EXECUTION_CONSUMER_GAP` = **PARTIAL**（pin/validate/retrieve 已闭环，
     执行消费只有 Supervisor 一条 closed，通用路径仍 open）。
5. **无新 authority**（`SUPERVISOR_AUTHORITY_GAP` / `run.approve` 治理债务，按 Boss 裁定保留）。
6. **无 human goal 生产入口**（`HUMAN_GOAL_PRODUCT_INGRESS_GAP`：IPC/UI 不在本 Sprint）。
7. **无 human escalation runtime**（`HUMAN_ESCALATION_STATE_GAP`，属 T18-07）。
8. **`HANDLER_OUTPUT_CARRIER_GAP` 仍 OPEN**：AgentRuntime 输出未自动进入任何 sink。
9. **`CORRECTIVE_TASK_*` 的 `TASK_FAILED` / `TOOL_FAILED` cause 仍拒绝**（V1 只支持
   `REVIEW_FINDING` / `VALIDATION_FAILED`）。
10. Supervisor 的调用入口（哪个受信入口触发一次 turn、触发频率）属 T18-07/T18-08；
    T18-06 只提供 in-process 的 `supervisorDecisionRuntime`。
11. **引擎不安装定时器**（boundary gate）：mock adapter 的"在飞"窗口由注入的 sleeper 提供
    （与 `now` 同样的注入模式），默认立即返回 ⇒ 未提供 sleeper 的调用方行为不变。
12. **provider 层无内建 retry loop**（错误里的 `retryAfterMs` 只是信息，不驱动重试）；adapter
    若自行重试，必须遵守 signal 契约——backoff 中观察到 abort ⇒ 停止下一次 attempt，
    且不得回退到别的 provider/model。真实第三方 provider adapter 尚未落地（V1 只有 mock
    adapter），因此 signal 契约已在唯一生产 adapter 上闭环。

## 14. ADR-0029（**Accepted**，标题：Autonomous Supervisor and Corrective Work — Authority, Corrective Semantics and Execution Context）

已由 Boss 于 T18-02 批准落文件（`docs/adr/0029-autonomous-supervisor-and-corrective-work.md`，12 条 ruling，T18-05 corrective 章节已追加）。摘要：Supervisor 是 run 作用域应用服务，不是新状态机层、不是第二个
dispatcher、不是新 authority 主体；其决策以 `DecisionRecord` 为唯一账本，其副作用只经
既有命令面与既有服务，其纠正语义与 engine 的 `maxAttempts` 自动重试严格分离；运行目标
不得进入 `RunSnapshot` pin 集；pack 中立。Rationale：复用既有三件套（ledger 指纹回放 /
CAS / 每命令一事务）可比新建机制更早获得崩溃安全与可审计性；把监督者做成引擎内的新层会
同时破坏 L1/L3 冻结与 single-writer workspace 原则。
