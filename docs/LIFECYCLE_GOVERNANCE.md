# Lifecycle Governance 实现（Sprint 4）

> 本文记录 **Sprint 4 的实现与决策**。生命周期能力的**规范词表**在既有的
> `docs/WORKFLOW_LIFECYCLE.md`（V1.1 Bible，源自 `.planning/CANONICAL_SPEC.md`）；
> 两者冲突时以代码（`packages/core/src/lifecycle/**`）与 ADR-0007 为准。
> 依据：规划书 §七（Fork）、§八/§九（版本化）、§十（禁止原地修改）、§十一（Run Snapshot）；
> ADR-0003（状态分层）、ADR-0006（持久化）、ADR-0007（本 Sprint 决策）。

## 1. Workflow Lifecycle Architecture

```text
@companyos/core        L2 领域（纯函数 + 不变量，行业无关）
  lifecycle/machine.ts         4 态状态机 + 8 个转移 + emits 词表
  lifecycle/template.ts        Draft / Publish / openRevision / publishRevision / Fork / Deprecate / Archive
  lifecycle/version.ts         不可变 WorkflowVersion + contentHash + semver
  lifecycle/snapshot.ts        RunSnapshot + snapshotHashOf + versionSnapshotHash + verifyRunSnapshot
  lifecycle/change-proposal.ts ChangeProposal（open/accept/reject/supersede + 职责分离）
  lifecycle/template-lock.ts   TemplateLock（run/global、assertMutable、assertForkable、lockPolicyFor）

@companyos/engine      lifecycle-service.ts —— 外环编排（只 import @companyos/core）
  读聚合 → 调 Core 纯函数 → 同一事务持久化 + 写事件 → 返回 Result

@companyos/persistence migrations/lifecycle/0001_workflow_lifecycle.sql + 四个 SQLite store
```

**分工**：Core 拥有**规则**，service 拥有**事务与 IO**，persistence 拥有**表与约束**。
service 里没有一条自己发明的领域规则——Draft→Publish、不可变、提案必须先被接受、锁策略、
废弃/归档的拒绝码全部来自 Core。

## 2. Template State Model

L2 四态（与 L1 的 17 个 Run 态**永不混用**，ADR-0003）：

| 状态 | 含义 | 允许的转移 |
|---|---|---|
| `draft` | 设计态，工作版本可改 | `publish` → published；`lock`/`unlock` |
| `published` | 有 `currentVersionId`，可创建 Run | `open_revision`、`publish_revision`、`fork`、`deprecate`、`lock`/`unlock` |
| `deprecated` | 禁止新 Run，旧 Run 继续 | `fork`、`archive`、`lock`/`unlock` |
| `archived` | **终态、只读**、留档审计 | 无（吸收态） |

`draftVersionId` 只在首个版本之前或修订进行中存在，发布时被清空。

**事件词表以 `TRANSITIONS[].emits` 为唯一真相源**；service 额外声明的 4 个事件
（`GOVERNANCE_EVENT_TYPES`：草案改写、提案开启/接受/拒绝）**不改变模板状态**，因此不属于状态机。
`tests/sprint4/governance.test.ts` 断言机器声明的每个事件类型都有真实发射方。

## 3. Versioning Strategy

- semver：首版 `1.0.0`；修订草案 `1.1.0-draft` → 发布 `1.1.0`；
- `UNIQUE (template_id, semver)`（需求 M，数据库强制）；
- 发布把草案版本**原地转正**（同 id、去 `-draft`、重算 `contentHash`）；
- 已发布版本全部保留；`releasedVersions()` 过滤草案；
- 产生新版本的路径只有两条：`publish`（首版）与 `publishRevision`（修订，需已接受的提案）。

**Sprint 4 修正的 Core 缺陷**：`publishRevision` 原先只改 semver 而不重算 `contentHash`，
转正后的版本 `isVersionIntact()` 为 false、持久化指纹错误。现在发布时重算，
测试断言 `revised.versions.every(isVersionIntact)`。

## 4. Immutability Strategy（需求 6/7/8）

1. **Core**：发布后模板不再是 `draft`，`saveDraftGraph` → `ILLEGAL_TRANSITION`；
2. **Service**：唯一修改路径是 `Change Proposal → accept → openRevision → publishRevision`；
   存在活跃锁时所有可变操作 `LOCKED_TEMPLATE`；
3. **Persistence**：`sqlite-template-store.put` 逐版本核对，**已发布行被改写即 `CONFLICT`**；
   `delete` 永远拒绝；只有**草案**行可能因被发布取代而清理。

## 5. Run Snapshot Binding（需求 10/11）

- 创建 Run：`requireState(['published'])` → `isRunnable` → 取 `currentVersion` →
  **临时获取 run 作用域锁**（Core 要求快照绑定 ACTIVE 锁）→ `createRunSnapshot`
  （哈希覆盖 orgId/templateId/versionId/lockId/packVersions/modelBindings/memoryViewRef）→
  写 `runs` + `run_snapshots` → **立即释放锁**（这是"钉"不是"闸"，同模板可先后启动多个 Run）；
- **升级不影响已跑的 Run**：`run_snapshots` 是冻结副本，已发布版本行不可变，
  老 Run 永远指向老内容（测试 E：Run 在 1.0.0 上跑完，期间模板升级到 1.1.0，其 `versionId`
  与快照校验结果不变）；
- `verifyRunSnapshot` 可随时重算（需求 N：篡改 `snapshot_hash` → `SNAPSHOT_MISMATCH`）。

## 6. Lock / Proposal Design（需求 14、7、K）

**TemplateLock**：作用域 `run`/`global`，`releasedAt === null` 为活跃。
**数据库级互斥**：`CREATE UNIQUE INDEX idx_locks_one_active ... WHERE released_at IS NULL`
——保证**每模板最多一个活跃锁**（跨进程成立，显式 `lock()` 竞争得到 `CONFLICT/lock_held`）。
双发布不可能同时成功的原因更精确地说有两条：①发布窗口的取锁/发布/释放与草案消费在**同一事务**内，
②事务被 `UnitOfWork` 单连接 FIFO 串行化，第二个发布看到的草案已被消费（见 ADR-0007 §10）。
策略来自 Core：`assertMutable`（有锁即拒绝改写/修订/发布）、`assertForkable`（只有 global 锁拒绝 Fork）、
归档只被 **run 作用域**锁阻止（与状态机 guard 文本一致）。
**发布窗口**：`publishRevision` 在同一事务内取锁 → 发布 → 释放；失败/崩溃整体回滚，
**不遗留锁、不可能双发布**（测试 J：两个并发发布恰好一个成功，事后无活跃锁）。

**ChangeProposal**：作者与决策者必须不同人（Core 强制）；只能针对 `currentVersionId` 起草
（基线过期 → `PROPOSAL_NOT_ACCEPTED`）；同一 (模板, 基线) 只允许一个 `open`（部分唯一索引）；
`rejected`/`superseded` 永久不能开启修订。

## 7. Persistence（需求 1–4、16、17）

第三条校验和迁移链 `migrations/lifecycle/0001_workflow_lifecycle.sql`（core / engine 链未改动）：

| 表 | 关键约束 |
|---|---|
| `workflow_templates` | `state` CHECK(4 态) · `current_version_id` · `draft_version_id` · `forked_from_json` |
| `workflow_template_versions` | `UNIQUE (template_id, semver)` · `immutable` CHECK(=1) · `content_hash` · `snapshot_hash` |
| `workflow_template_locks` | `scope` CHECK(run/global) · **部分唯一索引：每模板最多一个活跃锁** |
| `workflow_change_requests` | `status` CHECK(4) · **部分唯一索引：每模板/基线最多一个 open** |
| `run_snapshots` | `UNIQUE (run_id)` · `snapshot_hash` · `(workflow_version_id)` 索引 |

链由组合根选择：`openDurableDatabase({ chains: ['core','engine','lifecycle'] })`；
未启用时生命周期 store 是"拒绝服务"桩（抛 `PERSISTENCE_FAILED` 并提示如何开启），不静默返回空。

所有生命周期写操作 + 事件追加在**同一 `UnitOfWork` 事务**内。**崩溃安全**（需求 17）：
草案保存、首版发布、修订发布失败都整体回滚（无版本、无状态变化、无锁、无事件），修复后重试即可；
重启后提案/锁/版本/快照原样保留并能继续（测试 L）。

## 8. 测试矩阵（用户 A–O）

| # | 场景 | 位置 |
|---|---|---|
| A | Draft 可修改（多次保存 + 重启保留） | `tests/sprint4/lifecycle.test.ts` |
| B | Published 禁止修改（服务层 + 存储层双拒） | 同上 |
| C | Fork 产生新 Draft（lineage、源模板不变、新草稿可编辑） | 同上 |
| D | Publish 新版本（保留旧版本、哈希重算、发布窗口释放） | 同上 |
| E | 旧 Run 不受新版本影响（跑完 + 快照校验） | 同上 |
| F | 新 Run 使用新版本 | 同上 |
| G | Deprecated 禁止新 Run（`DEPRECATED_TEMPLATE`） | `tests/sprint4/governance.test.ts` |
| H | Deprecated 旧 Run 继续跑完 | 同上 |
| I | Archived 只读（禁改/禁 Fork/禁删，仍可读） | `tests/sprint4/lifecycle.test.ts` |
| J | 双发布 Lock 冲突（唯一活跃锁 / 阻塞修订发布归档 Fork / 并发双发布一胜） | `tests/sprint4/governance.test.ts` |
| K | Change Proposal Reject（拒绝后不可开修订 + 职责分离 + 过期基线） | 同上 |
| L | 重启后 Proposal/Lock/Version/Snapshot 保留并继续 | `tests/sprint4/restart.test.ts` |
| M | 重复 version number 拒绝（`UNIQUE` → `CONFLICT`） | `tests/sprint4/lifecycle.test.ts` |
| N | Snapshot Hash 校验（篡改 → `SNAPSHOT_MISMATCH`） | 同上 |
| O | Lifecycle Event 顺序正确（14 条按序 + 位置稠密 + 词表全覆盖） | `tests/sprint4/governance.test.ts` |
| 边界 | Core/Engine 无 SQL、无行业词、生命周期链独立 | `tests/sprint4/boundary.test.ts` |

## 9. 与后续 Sprint 的接口

- 模板库查询（Workflow Library UI）属 Sprint 29，`templates.list()` 已可用；
- `lifecycle/metrics.ts` 尚未接事件流，可从 `events.readByRun` / `readByAggregate` 计算；
- `orgId` 已落库，后续授权模型可直接做租户隔离；
- 提案的 `ChangeOp` 目前只记录，**未应用到图上**（应用逻辑属 Workflow Designer 阶段）。
