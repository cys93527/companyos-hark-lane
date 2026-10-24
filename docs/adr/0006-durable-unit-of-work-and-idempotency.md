# ADR-0006：持久化单元、跨重启幂等与事件顺序

> 归属：Sprint 3（Persistence，P0）；规划书 §五十六（SQLite + 迁移）、§四十五（Recovery）、§四十四（Audit）；
> 上游 ADR-0002（端口冻结）、ADR-0005（引擎边界与幂等）。

## 状态

**已接受（Accepted）** — Sprint 3 交付。

## 背景

Sprint 2 交付了确定性引擎，但所有状态都在内存：进程一结束，Run、Task、Approval、事件与幂等账本
全部消失。Sprint 3 必须在不破坏两条既有约束的前提下补齐持久化：

1. **Core 只看到 Port**：SQL 与 SQLite 绝不能进入 Core，也不能进入 Engine（用户特别要求）；
2. **单一 Writer / 可复现**：引擎的确定性不能被"落库时的并发交错"破坏。

同时要解决三个具体问题：**写读原子性**（状态 + 事件 + 账本必须一体提交）、
**跨重启幂等**（`commandId` 不能在重启后失效）、**事件顺序**（回放必须稳定）。

## 决策

### 1. 持久化是外环适配器，组合根负责接线

`@companyos/persistence` 实现 Core 端口；`@companyos/engine` 只接受端口。
集成测试放在仓库根 `tests/`（既不属于 persistence 也不属于 engine），因此
`persistence` 的依赖里**永远不需要**出现 `engine`，反之亦然。

### 2. 新增的 Core 契约只有一个端口

`CommandLedgerPort`（`get` / `put` / `count` / `trim`）+ 错误码 `PERSISTENCE_FAILED`（加法式扩展）。
端口对 outcome 采用**不透明 JSON 快照**（`outcome: Readonly<Record<string, unknown>>`），
所以 Core 不需要知道引擎的 `DispatchOutcome` 形状 —— 契约保持行业无关与实现无关。

### 3. UnitOfWork：原子 + 串行 + 可嵌套

- 原子：`BEGIN IMMEDIATE` … `COMMIT`，抛错即 `ROLLBACK`；
- 串行：单连接上的事务进入 FIFO 队列，避免 `await` 交错；
- 可嵌套：`AsyncLocalStorage` 判定"已在事务中"，嵌套调用加入外层（SQLite 不支持嵌套 BEGIN）。

**所有写操作进入同一事务**：审批副作用 → `runs.put` → `events.append` → `command_ledger.put/trim`。
因此"状态已写、事件未落"或"状态已写、账本未落"在结构上不可能出现。

### 4. 事件顺序：`global_position` 是唯一权威

append 时分配 `MAX(global_position) + 1`（同一事务内稠密递增），加 UNIQUE 索引。
不用时间戳（可重复、可回拨），不用 `rowid`（会被复用）。

### 5. 跨重启幂等：账本落库 + 有界窗口

`command_ledger` 持久化 `commandId → (fingerprint, run_id, outcome_json, recorded_at)`；
窗口由 `trim(maxLedgerEntries)` 显式界定（默认 1000，淘汰最旧）。
被淘汰的命令不再被识别为重复，而是因 `revision` 过期被拒 —— 这是**可解释**的退化，而不是静默失效。

### 6. 两条校验和迁移链，互不干扰

core 链（`migrations/`，Sprint 0 冻结）与 engine 链（`migrations/engine/`，Sprint 3）共用
`schema_migrations` 但文件与版本各自独立。理由：`0001_init.sql` 已冻结且既有测试断言默认链只有它；
把新表塞进同一目录会改变默认链的内容，属于对既有契约的破坏。

## 后果

**收益**

- 重启后：未完成 Run 可继续、未决审批可决策、返工计量与恢复点如实保留、重复命令不二次执行；
- "半成功"不可构造：事务边界与命令边界对齐（A/B/C/J 四个场景有回归测试）；
- 事件流成为可审计、可回放的**已发生事实**唯一来源（位置稠密、跨重启一致）；
- Core/Engine 仍然不知道 SQLite 的存在（边界测试给出机器证据）。

**代价与限制**

- 单连接串行事务 ⇒ 单 Run 写入吞吐受限于顺序提交（与 V1「单 Workspace、串行 Agent」一致）；
- `node:sqlite` 是同步 API，事务跨 `await` 时依赖引擎侧的串行化与 FIFO 语义；
- 账本窗口有界：超窗命令退化为 revision 拒绝（已在 §5 与 `WORKFLOW_ENGINE.md` 写明）；
- 未做审计哈希链（Sprint 4+）、未做事件压缩/归档、未做多进程并发写（V1 为单进程）；
- **未注入 `UnitOfWork` 时事务静默缺席**（Sprint 2 的内存接线即如此）—— 现已改为记一条 `warn`，
  并把「组合根必须注入」写入本节；内存实现无可回滚之物，但生产接线漏传会无声失去原子性；
- **阶段执行的事务由本 ADR 修订纳入**（评审 HIGH-1）：task 状态写 + task 事件 + 阶段级
  `EXECUTION.COMPLETE/FAIL` 现在同属一个事务；此前它们只在 per-run 串行化之下，不属于任何事务。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 让 Engine 直接持有 SQLite 连接 | 违反用户硬约束，且会把外环实现细节带进解释器 |
| 在 Core 里定义 `DispatchOutcome` 形状的账本端口 | Core 会耦合引擎 DTO；改为不透明 JSON 快照 |
| 把 Sprint 3 的表加进 `0001_init.sql` | 迁移已冻结（校验和 + 既有测试），属破坏性变更 |
| 用时间戳/`rowid` 排序事件 | 不稳定（时钟回拨、rowid 复用），回放会错序 |
| 事务外先写状态再写事件 | 崩溃窗口会留下不一致状态（Sprint 2 已记录该偏差，本 Sprint 关闭） |
| 嵌套 `BEGIN` 支持内层事务 | SQLite 明确不支持；用 ALS 让嵌套加入外层更简单可靠 |

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | Sprint 3 | 初版：外环持久化、UnitOfWork 三语义、global_position 顺序、跨重启幂等、双迁移链 |
