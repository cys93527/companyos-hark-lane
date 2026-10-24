# ADR-0003：状态分层冻结（L1 全局 17 态 / L2 模板生命周期 4 态 / L3 Task·Stage 局部态）

> 归属：规划书 §三十三（通用 State Machine）、§六/§七（模板生命周期）、用户 STEP 3B。

## 状态

**已接受（Accepted）** — Sprint 1 生效。

## 背景

Sprint 0 期间的状态文档把 `draft / published / deprecated / archived` 当成"the 状态机"，
而规划书 §三十三 明确给出的是 **17 个全局状态**。两者不是同一层的东西：一个是**制度的版本状态**，
一个是**一次业务执行的推进状态**。混用会导致：

- 无法表达"模板已发布但某次执行正处于返工中"；
- 审批、恢复、返工无处落位（它们属于执行层，不属于模板层）；
- 领域模型被迫把两种生命周期挤进同一个字段。

## 决策

### 三层状态（**禁止混用**）

#### L1 — Workflow Run / Execution State（全局执行态，17 个，规划书 §三十三）

| # | 状态 | 含义（进入条件） |
|---|---|---|
| 1 | `IDLE` | 无活动执行；系统就绪 |
| 2 | `INITIALIZING` | 正在装载模板快照、校验锁与包版本 |
| 3 | `DESIGNING_WORKFLOW` | 无可用 SOP，由 Chief 设计 Workflow Draft |
| 4 | `WORKFLOW_REVIEW` | Draft 待评审 |
| 5 | `WORKFLOW_PUBLISHED` | Draft 已发布为模板，可创建 Run |
| 6 | `PLANNING` | 正在拆解 Stage / Task / 验收标准 |
| 7 | `ROUTING` | 正在选择模型与工具（**Sprint 1 只做状态位，不做路由实现**） |
| 8 | `WAITING_APPROVAL` | 阻塞在人工审批（HIGH/CRITICAL 风险） |
| 9 | `EXECUTING` | Agent 正在执行当前 Stage/Task |
| 10 | `REVIEWING` | 独立评审中 |
| 11 | `VALIDATING` | 运行 Validator（真实命令）中 |
| 12 | `REWORK` | 评审/验证失败后返工（默认上限 3 次） |
| 13 | `FINALIZING` | 全部通过，正在交付与归档产物 |
| 14 | `COMPLETED` | 终态：交付完成 |
| 15 | `FAILED` | 终态：不可恢复失败（含取消/超时的最终落点） |
| 16 | `PAUSED` | 暂停（返工超限、崩溃恢复等待裁决、用户暂停） |
| 17 | `RECOVERING` | 崩溃/中断后按事件日志恢复中 |

终态：`COMPLETED`、`FAILED`（吸收态）。`PAUSED` 可被显式裁决后继续或转入终态。

#### L2 — Workflow Template Lifecycle（模板版本状态，4 个）

`DRAFT` → `PUBLISHED` → `DEPRECATED` → `ARCHIVED`（`ARCHIVED` 吸收）。
另有两个叠加态：`FORKED`（血缘标记，不是状态）、`RUNNING`（模板"正在被执行"是**查询视图**，
由 L1 的执行态与 RunSnapshot 推导，**不是** L2 状态）。

> 命名说明（review finding NIT-1）：代码中 L2 状态是小写（`lifecycle/machine.ts` 的
> `draft|published|deprecated|archived`），本文档与 `docs/STATE_MACHINE.md` 用大写写法指代同一集合；
> 测试通过 `toUpperCase()` 对照。L1 的 `WORKFLOW_PUBLISHED` **不是** L2 的 `PUBLISHED`。

#### L3 — Task / Stage 局部态

- `Stage`：`PENDING` → `READY` → `ACTIVE` → `DONE` / `FAILED` / `SKIPPED`（局部，不跨模板）。
- `Task`：`PENDING` → `READY` → `RUNNING` → `BLOCKED` → `DONE` / `FAILED` / `CANCELLED` / `SKIPPED`。
- 节点级机器（`NodeExecutionState`）、交接机器（`HandoffState`）、提案机器（`ChangeProposalState`）、
  锁机器（`TemplateLockState`）同属 L3 的实现细节。

### 取代关系（旧词表 → 新分层）

Sprint 0 文档中的 8 态运行词表（`queued`/`running`/`paused`/`waiting_handoff`/`succeeded`/
`failed`/`cancelled`/`timed_out`）**被本 ADR 取代**，映射关系：

| 旧 | 新（L1） |
|---|---|
| `queued` | `INITIALIZING`（快照已固定、尚未分派） |
| `running` | `EXECUTING`（或 `REVIEWING` / `VALIDATING`，取决于当前 Stage） |
| `waiting_handoff` | `WAITING_APPROVAL`（人工审批）或 `EXECUTING`（跨角色交接） |
| `paused` | `PAUSED` |
| `succeeded` | `COMPLETED` |
| `failed` | `FAILED` |
| `cancelled` | `FAILED`（取消原因记录在事件与 Run 的 `reason` 字段，不单列状态） |
| `timed_out` | `FAILED`（超时原因同上） |

### 实现与强制

- 机器实现：`packages/core/src/domain/run-state.ts`（`RUN_STATES`、`RUN_TRANSITIONS`、`nextRunState`）；
- 镜像文档：`docs/STATE_MACHINE.md`（§1 分层声明 + §4 为 L1 的 17 态机）；
- 测试：`packages/core/tests/domain/run-state.test.ts` 锁定 17 态齐全、非法转移抛
  `ILLEGAL_TRANSITION`、终态吸收、`PAUSED`/`RECOVERING` 的进出条件；
- **禁止**把 L1 与 L2 混成一套状态机（例如把 `PUBLISHED` 当作执行态，或把 `EXECUTING` 当作模板态）。

### 两条在评审中被发现并修正的细则（Sprint 1 review）

1. **暂停只属于执行期（HIGH-2）**：`PAUSE` 的合法来源被收窄为
   `PAUSABLE_RUN_STATES = {PLANNING, ROUTING, WAITING_APPROVAL, EXECUTING, REVIEWING, VALIDATING, REWORK, FINALIZING}`。
   理由：若 `IDLE`/`INITIALIZING`/`DESIGNING_WORKFLOW`/`WORKFLOW_REVIEW`/`WORKFLOW_PUBLISHED` 也能暂停，
   则 `PAUSE` + `RESUME` 两个事件即可越过规划、路由与审批门。
2. **恢复不跳步（HIGH-2）**：`RESUME` / `RECOVERED` 必须返回暂停/崩溃时记录的 `resumePoint`
   （机器通过 `nextRunState(event, from, { resumePoint })` 接收），仅在无记录点时才回退到 `EXECUTING`；
   恢复后清空 `resumePoint`。
3. **返工预算口径（LOW-3）**：`maxRework` = **允许完整回到执行的返工轮次**。第 (maxRework+1) 次进入
   `REWORK` 之后，`REWORK_READY` 被拒绝（`LIMIT_EXCEEDED`），只能用 `REWORK_EXHAUSTED` 离开 → `PAUSED`。
   即默认 `maxRework = 3` 允许 3 轮完整返工，第 4 次退回触发暂停（规划书 §三十五）。

## 后果

**收益**：模板版本治理与执行推进解耦；审批、返工、恢复有了明确归属；后续 Sprint 2 的
Workflow Engine 直接消费 L1 机器，不必再动 Core 词表。

**代价**：`FAILED` 承担了取消与超时两种语义，区分依赖 `reason` 字段与事件类型——
这是有意的取舍：状态枚举保持 17 个（与规划书一致），语义细节交给事件与审计。

**被否决方案**：

| 方案 | 否决理由 |
|---|---|
| 保留 8 态运行词表 | 与规划书 §三十三 的 17 态直接冲突，且无法表达审批/恢复/返工 |
| 把 17 态与 4 态合成一个枚举 | 概念层级不同，会导致"模板已归档但执行仍在进行"这类状态无法表达 |
| 把 `cancelled` / `timed_out` 保留为独立状态 | 会突破规划书给定的 17 态清单 |

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | Sprint 1 | 初版：三层状态分层 + 17 态 L1 机器 + 旧词表映射 |
