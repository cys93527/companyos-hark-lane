# ADR-0007：Workflow Lifecycle 的治理边界、不可变性与锁语义

> 归属：Sprint 4（Workflow Lifecycle，P0）；规划书 §七–§十一（Fork / 版本化 / 版本 / 禁止原地修改 / Run Snapshot）；
> 上游 ADR-0002（端口冻结）、ADR-0003（状态分层）、ADR-0006（持久化与事务）。

## 状态

**已接受（Accepted）** — Sprint 4 交付。

## 背景

Sprint 1 把 L2 生命周期**规则**写进了 Core（4 态状态机 + 模板/版本/提案/锁/快照的纯函数），
但没有任何持久化与编排：模板无法保存、无法发布、无法审计，也没有把"已发布模板不可原地修改"
变成一条真正拦得住的路径。Sprint 4 必须补齐，同时满足用户的三条硬约束：
Core 保持行业无关、Engine 不知道具体行业、Persistence 不反向依赖 Engine。

## 决策

### 1. 规则在 Core，事务与 IO 在 service，表和约束在 persistence

新增 `packages/engine/src/lifecycle-service.ts`（外环编排），它只 import `@companyos/core`，
按「读聚合 → 调 Core 纯函数 → 同事务持久化 → 写事件」工作。领域规则一条都不复制进去：
每个拒绝码都来自 Core（`requireState`、`requireAcceptedProposal`、`assertMutable`、`assertForkable`、
`createRunSnapshot` 的锁前置条件）。

### 2. Draft 是可变的版本行，而不是另存一份图

草案就是 `workflow_template_versions` 里一条 `1.0.0-draft` / `1.1.0-draft` 行，`draftVersionId` 指向它。
好处：**"草案可改"与"已发布不可改"是同一条规则**（`semver` 是否含 `-draft`），
不需要第二个存储位置，也不会出现"图上改了但版本没变"的漂移。
代价：草案行会被改写（`contentHash` 随之重算），发布时该行原地转正。

### 3. 不可变性三层防线

Core（状态守卫）＋ service（唯一修改路径：提案 → 接受 → 开修订 → 发布）＋ persistence
（已发布行被改写即 `CONFLICT`；`delete` 永远拒绝；只有草案行可能消失）。

### 4. 数据库级互斥，而不是应用级判断

`workflow_template_locks` 上的**部分唯一索引**（`WHERE released_at IS NULL`）保证同一模板
最多一个活跃锁：并发双发布、跨进程双发布都会在 INSERT 处失败，而不是靠"先查后写"的竞态窗口。
发布窗口在**同一事务内**取锁与释放，因此失败/崩溃不会遗留锁。

### 5. Run 绑定冻结快照，锁是"钉"不是"闸"

创建 Run 时临时获取 run 作用域锁（Core 要求快照必须绑定活跃锁），生成快照后立即释放。
于是：快照有法律效力（有锁 id 与哈希），但同一模板仍可先后启动多个 Run。

### 6. 事件词表仍以状态机为唯一真相源

`TRANSITIONS[].emits` 保持不变；不改变模板状态的事实（草案改写、提案开启/裁决）由 service
在自己的 `GOVERNANCE_EVENT_TYPES` 里声明，并由测试断言"机器声明的每个事件都有真实发射方"。
生命周期事件写入同一个 `EventStorePort`（按 `global_position` 排序），与 run/task 事件共处一条日志。

### 7. 治理 schema 是第三条校验和链

`migrations/lifecycle/0001_workflow_lifecycle.sql`。理由与 ADR-0006 §6 相同：core 链与 engine 链
已冻结（并有既有测试锁定其内容），新关注点必须有自己的、可校验和的链。
链由组合根选择：`openDurableDatabase({ chains: ['core','engine','lifecycle'] })`；
未启用时生命周期 store 会**显式拒绝**，而不是静默返回空值。

### 8. 需求措辞到实现的映射（Sprint 4 评审 MEDIUM-3）

需求写的是「Draft → Review → Publish」与「Change Proposal → Fork → Draft → Review → Publish」。
ADR-0003 冻结 L2 为 4 态（无独立 `review` 态），因此映射如下：

| 需求措辞 | 实现 |
|---|---|
| Draft | `state='draft'`，工作版本（`*-draft`）可改 |
| **Review** | **修订**路径的提案裁决（`openProposal` → `decideProposal`，作者≠决策者）；首版发布**没有**独立评审门（Core 的 `publishInitialVersion` 不接受提案），这是有意的简化，等 Sprint 5+ 需要时再引入 |
| Publish | `publish`（首版）/ `publishRevision`（修订），都产生不可变版本并写事件 |
| Fork | **独立支路**：从 `published`/`deprecated` 克隆出一个新的 `draft` 模板；它不参与原地修订路径 |
| Change Proposal | 开启修订的唯一凭据；`accepted` 且基线等于当前版本才可用 |

即两条路径：**原地修订** = Proposal → Draft → Review(决策) → Publish；**分支** = Fork → 新 Draft → Publish。

### 9. 授权缺口与治理缝（Sprint 4 评审 MEDIUM-4）

生命周期服务**不做**权限判定，但它提供 `authorize` 政策缝：组合根注入后，每个可变操作
（`workflow.draft.create/edit`、`workflow.publish`、`workflow.propose`、`workflow.review`、
`workflow.fork`、`workflow.deprecate`、`workflow.archive`、`workflow.lock`、`run.start`）
都会先请求一次授权，拒绝即 `POLICY_DENIED`（有测试）。
**缺口**：未注入 `authorize` 时是 allow-all；真正基于 `Role.authority` 的解析需要 Role 存储，
属后续 Sprint（已记入 `PROJECT_HANDOFF.md`）。

### 10. 双发布防护的精确因果（Sprint 4 评审 LOW-1）

- **每模板最多一个活跃锁**：由部分唯一索引保证（跨进程成立），显式 `lock()` 竞争会得到 `CONFLICT/lock_held`；
- **同一模板的双发布不可能同时成功**：`publishRevision` 的取锁/发布/释放与草案消费在**同一事务**内，
  事务又被 `UnitOfWork` 单连接 FIFO 串行化；第二个发布看到的草案已被消费 → 拒绝；
- 换言之：索引负责"锁唯一"，事务串行 + 草案消费负责"发布唯一"。发布窗口本身**不**承担跨进程互斥。

## 后果

**收益**

- "已发布即不可改"从文档变成了三层可执行的约束，且每层都有测试；
- 版本内容可寻址（`contentHash`）且 Run 绑定冻结快照（`snapshotHash`），历史 Run 可复现、可校验；
- 双发布在数据库层被拒绝，不依赖进程内锁或时钟；
- 生命周期全程有事件（按序、稠密位置），审计与回放沿用 Sprint 3 的同一套机制；
- 崩溃安全：失败的操作整体回滚，重启后治理状态原样保留。

**代价与限制**

- 模板版本的 `graph` 以 JSON 存在版本行内（V1 规模下足够；大图需要拆表或压缩）；
- `saveDraftGraph` 的每次保存只写一条事件（草案不是状态转移，不逐字段审计）；
- 提案的 `ops` 只是记录（`ChangeOp` 尚未被应用到图上——应用逻辑属于 Workflow Designer/S18）；
- 生命周期 store 依赖组合根显式启用 `lifecycle` 链，忘记启用会得到明确的 `PERSISTENCE_FAILED`；
- 归档后模板行永久保留（这是需求，不是缺陷），但缺少批量归档/保留策略。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 把编排逻辑放进 persistence | 会让存储层拥有用例与事务编排，违反分层 |
| 新建 `@companyos/lifecycle` 包 | 目前只多一个文件；先放引擎外环，若继续膨胀再抽包（可逆） |
| Draft 图另存一列 | 会出现"两个真相"；草案即版本行更简单 |
| 应用层"先查活跃锁再写" | 有竞态窗口；部分唯一索引才是权威 |
| Run 长久持有锁 | 会把"钉"变成全局互斥，同模板无法并行启动 Run |
| 让 Engine 直接读写 SQLite | 违反硬约束，且会把外环实现细节带进编排层 |
