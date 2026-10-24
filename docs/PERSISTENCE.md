# CompanyOS 持久化（Sprint 3）

> 目标：把 Sprint 2 的**内存级** Workflow Engine 升级为**可恢复、可事务化、可重放**的持久化执行系统。
> 依据：规划书 §五十六（SQLite / WAL / Foreign Keys / Transactions / Migrations）、§四十五（Recovery）、
> §四十四（Audit）、§十一（Run Snapshot）；ADR-0002（端口冻结）、ADR-0005（引擎边界）、ADR-0006（本 Sprint 决策）。

## 1. Persistence Architecture

```text
apps / tests（组合根）
   │  注入 Core 端口
   ▼
@companyos/engine（外环解释器，只依赖 Core）        ← 不知道 SQLite
   │  EntityStore<WorkflowRun|Task|Approval> / EventStorePort
   │  CommandLedgerPort / UnitOfWork                 ← 全是 Core 契约
   ▼
@companyos/persistence（外环适配器）
   ├── db.ts                 PRAGMA WAL / foreign_keys / busy_timeout
   ├── migrations.ts         编号 SQL + sha256 校验和（Sprint 0 既有）
   ├── durable/
   │   ├── unit-of-work.ts          BEGIN IMMEDIATE / COMMIT / ROLLBACK + 串行化
   │   ├── sqlite-run-store.ts      WorkflowRun（含 resume_point / rework 计量）
   │   ├── sqlite-task-store.ts     Task（L3 局部状态 + attempts）
   │   ├── sqlite-approval-store.ts Approval（含决策与决策人）
   │   ├── sqlite-event-store.ts    events（global_position 稳定顺序）
   │   └── sqlite-command-ledger.ts command_ledger（跨重启幂等）
   └── migrations/engine/0001_engine_persistence.sql
```

**隔离规则（需求 15，且有自动化证据）**：

| 规则 | 强制方式 |
|---|---|
| Core 不得出现 SQL / SQLite / 外环实现导入 | `tests/sprint3/boundary.test.ts` |
| Engine 不得 import SQLite / persistence，只依赖 Core | 同上 + `packages/engine/tests/boundary.test.ts` |
| `@companyos/persistence` 不得依赖 `@companyos/engine` | 同上（检查 dependencies / peerDependencies） |
| 组合根负责把实现注入引擎 | 集成测试位于仓库根 `tests/`，不属于任何包 |

## 2. UnitOfWork Design

Core 的 `UnitOfWork` 端口（Sprint 0 冻结）实现了三重语义：

1. **原子性**：`transaction(work)` 包在 `BEGIN IMMEDIATE … COMMIT` 中；`work` 抛错 →
   `ROLLBACK` → 返回 `err(DomainError('PERSISTENCE_FAILED'))`；
2. **串行化**：所有事务在同一条 promise 链上排队（单连接、单 Writer），避免两个事务在 `await`
   之间交错；
3. **可嵌套**：`AsyncLocalStorage` 标记"当前上下文已处于事务中"，嵌套调用**加入外层事务**而不是
   再开一个（SQLite 不允许嵌套 `BEGIN`）。

引擎侧的顺序（Sprint 2 评审后固化，Sprint 3 纳入事务）：

```text
纯校验（applyRunEvent，不写任何东西）
   → 转移规则不变式
   → [ 事务开始 ]
        审批副作用（Approval 聚合 + approval.* 事件）
        runs.put（状态 + revision + resumePoint + 返工计量）
        events.append（global_position 递增）
        command_ledger.put（commandId + fingerprint + outcome）
        command_ledger.trim（有界幂等窗口）
   → [ COMMIT ]  ← 任一步抛错则整体 ROLLBACK，命令零副作用

阶段执行同样是**一个**事务（评审 HIGH-1 后修正）：
   → [ 事务开始 ] task 状态写 + task.* 事件 + 该阶段的 EXECUTION.COMPLETE/FAIL → [ COMMIT ]
```

**事务外的写为零**：进程内缓存（`approvalByRun` / `branchByRun`）只在 **COMMIT 之后**更新，
因为内存不参与回滚；未注入 `UnitOfWork` 时引擎会记一条 `warn`（不允许静默失去原子性）。

## 3. SQLite Schema

两条**校验和保护**的迁移链共用一张 `schema_migrations`：

| 链 | 目录 | 内容 |
|---|---|---|
| core（Sprint 0，冻结） | `migrations/` | `schema_migrations` · `entities` · `settings` · `events`（基础列） |
| engine（Sprint 3） | `migrations/engine/` | `runs` · `tasks` · `approvals` · `events.global_position` + 索引 · `command_ledger` |

为什么不改 `0001_init.sql`：它是校验和冻结的、且既有测试断言默认链只有它。Sprint 3 的 DDL 因此
落在独立链中，`currentVersion` 各自计算（各为 1），互不干扰。

关键列：

| 表 | 关键列 |
|---|---|
| `runs` | `state`（CHECK 为 L1 的 17 态）· `revision` · `rework_count` · `max_rework` · `failure_reason` · `resume_point`（CHECK 为 8 个执行期状态）· `history_json` · `snapshot_id` |
| `tasks` | `state`（CHECK 为 8 个 L3 态）· `attempts` · `max_attempts` · `inputs_json`/`outputs_json` |
| `approvals` | `risk_level`（CHECK 四级）· `status`（CHECK 四态）· `requested_by`/`decided_by`/`decision_note` |
| `events` | `global_position`（唯一索引）· `aggregate_type`/`aggregate_id` 复合索引 · `trace_id` · `payload` |
| `command_ledger` | `command_id`（PK）· `fingerprint` · `run_id` · `outcome_json` · `recorded_at` |

## 4. Event Ordering Strategy

- 每条事件在 `append` 时获得 **`global_position = MAX(global_position) + 1`**，同一事务内连续递增；
- `global_position` 是**唯一**的排序权威（不用时间戳、不用 `rowid`），并有 UNIQUE 索引；
- 按 WorkflowRun 回放 = `WHERE aggregate_type='WorkflowRun' AND aggregate_id=? ORDER BY global_position`；
- **整轮执行审计** = `readByRun(runId)`：run 级 + task 级事件一起按位置返回
  （task 事件的 payload 带 `runId`，落库到 `events.run_id` 列，有 `(run_id, global_position)` 索引）；
- 游标回放 = `readFrom(position, limit)`（严格 `>` 游标，分页确定）；
- 事件不可变：只插入、不更新、不删除；`events.all()` 仅用于审计与测试。
- 幂等账本的淘汰顺序也只认**内部插入序**（`rowid`），不认调用方时钟的 `recorded_at`。

## 5. Durable Idempotency

| 机制 | 位置 | 行为 |
|---|---|---|
| `commandId` 记账 | `command_ledger`（SQLite） | 重启后重放同一命令 → 返回**首次记录的 outcome**（`duplicate: true`），不再执行、不再产事件 |
| 内容指纹 | `fingerprint` 列 | 同 key 不同内容 → `CONFLICT` |
| 有界窗口 | `trim(maxLedgerEntries)` | 按 `recorded_at` 淘汰最旧记录；被淘汰命令退化为"revision 过期被拒"（语义明确、可解释） |
| 乐观并发 | `runs.revision` | 过期命令在任何生命期（含重启后）都被 `CONFLICT/stale_revision` 拒绝 |

关键点：**ledger 写入与状态/事件在同一事务内**，所以"状态已写、账本未写"这种会造成重复执行的状态
在结构上不可能出现。

## 6. Recovery Strategy

1. **重启恢复**：重新打开同一 SQLite 文件并重建引擎（新的 store/uow/ledger 实例）；
2. **未完成 Run**：`drive(runId)` 从持久化的 L1 状态继续；`EXECUTING` 但调用方未提供 stage 时
   停止并报 `needs_decision`（不猜测）；
3. **崩溃恢复**：`recover(runId)` 对 `EXECUTING/PLANNING/REVIEWING/...` 先记 `CRASH_DETECTED`
   （`resumePoint` 落库）再 `RECOVERED` → 回到记录点；`PAUSED` **永不自动恢复**（需显式 `RESUME`）；
4. **中断任务**：任务行若停在 `RUNNING`（进程当时被杀），重建后由执行器归一化为
   `FAIL → RETRY → READY` 再跑一次，`attempts` 如实累加；
5. **幂等保护**：崩溃后重放同一命令不会二次执行（§5）。

## 7. 测试矩阵（用户 A–L）

| # | 场景 | 文件 |
|---|---|---|
| A | 原子提交成功（run + events + ledger 同事务可见） | `tests/sprint3/atomicity.test.ts` |
| B | Event 写失败整体回滚 | 同上 |
| C | Ledger 写失败整体回滚 | 同上 |
| D | duplicate command 跨重启仍幂等 | `tests/sprint3/durability.test.ts` |
| E | stale revision 跨重启仍拒绝 | 同上 |
| F | resumePoint 重启后保留 | 同上 |
| G | Approval 重启后保留（pending 可决策 / rejected 可追溯） | 同上 |
| H | Rework 状态重启后保留（含预算耗尽 → PAUSED） | 同上 |
| I | Event 顺序与重放一致（位置稠密、游标、跨重启一致） | `tests/sprint3/event-order.test.ts` |
| J | 事务中途异常无半成功（含审批副作用回滚） | `tests/sprint3/atomicity.test.ts` |
| K | Migration checksum（两条链、幂等、篡改即拒） | `tests/sprint3/migration.test.ts` |
| L | Engine 重建后继续未完成 Run（含中断任务重跑、崩溃恢复） | `tests/sprint3/continue-run.test.ts` |
| 15 | 边界：Core/Engine 不含 SQL、persistence 不依赖 engine、端口结构实现 | `tests/sprint3/boundary.test.ts` |

## 8. 边界与后续

- **不进入 Core 的东西**：任何 SQL、任何 SQLite 类型、任何文件路径、任何事务实现细节。Core 只增加了一个
  纯类型端口（`CommandLedgerPort`）与一个错误码（`PERSISTENCE_FAILED`，ADR-0002 允许的加法式扩展）。
- **不进入 Engine 的东西**：`node:sqlite`、`@companyos/persistence`、SQL 文本；引擎只认
  `EntityStore` / `EventStorePort` / `CommandLedgerPort` / `UnitOfWork`。
- **Sprint 4 之后的接口**：模板/版本/锁/提案的持久化（Workflow Lifecycle）、事件总线落库、
  审计哈希链、`Workflows` 库查询（Workflow Library）。
