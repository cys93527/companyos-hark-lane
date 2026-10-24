# Workflow Designer（Sprint 5）

> 目标：验证用户能通过桌面 UI **安全地**创建、修改、校验、Review、Publish、Fork 与版本化 Workflow，
> 而**所有业务规则仍由 `WorkflowLifecycle` / Core 控制**。不做复杂流程图软件（Sprint 5 §8）。
> 依据：规划书 §五十九（Sprint 5）、§四十七（IPC 与最小权限）、§十（禁止原地修改）；
> ADR-0002/0003/0006/0007/0008。

## 1. 架构原则（不可谈判）

```text
Renderer（apps/renderer）
   │  window.companyos.workflowRequest({ operation, payload })   ← 唯一入口，一次一个 operation
   ▼  IPC: 'companyos:workflow'（allow-list 之一）
Desktop 应用层（apps/desktop/src/workflows.ts）
   │  parseWorkflowRequest → schema 校验 → 只调用 WorkflowLifecycle
   ▼
WorkflowLifecycle（packages/engine/src/lifecycle-service.ts）
   ▼  Core 纯函数（applyChangeOps / validateWorkflowGraph / machine）
Core Domain
   ▼
Persistence（SQLite，只由 main.ts 打开：chains = core + engine + lifecycle）
```

**禁止**（有自动化证据）：

| 规则 | 证据 |
|---|---|
| Renderer 直接访问 SQLite | `tests/sprint5/designer-boundary.test.ts`（O） |
| Renderer 复制 Core 业务规则 | 同上（P）：不得出现 `TRANSITIONS` / `nextState` / `RISK_LEVELS` / `applyRunEvent` 等 |
| Renderer 具第二真相源 | 只做投影（`designer-model.ts` 纯函数），真实状态每次从 IPC 重读 |
| 绕过 `WorkflowLifecycle` 写数据 | 应用层只 import `@companyos/engine` 的 service 与 `@companyos/core` 的纯函数；SQL 只在 persistence |
| Published 被直接修改 | Core/Lifecycle 双拦（服务层 `ILLEGAL_TRANSITION` + 存储层 `CONFLICT`），见 `tests/sprint4` |

## 2. IPC Architecture

- **单一通道**：`companyos:workflow`（Sprint 0 的 allow-list 由 3 条增至 4 条；这是一次**显式契约变更**，
  经用户 Sprint 5 STEP 3 授权，`channels.test.ts` 保持"精确匹配"并新增"只有一个 feature channel"断言）。
- **单一入口**：`createWorkflowApi({lifecycle, listTemplates, roleIds, validatorIds, usageCounts}).handle(raw)`。
- **先校验后执行**：`parseWorkflowRequest` 检查对象形状、operation 白名单、`requestId`、逐 operation 字段
  （`templateId` / `actorId` / `ops[]` / `graph` 结构 / `decision` 枚举 / 文本长度上限 512），
  任何不合格一律 `INVALID_ARGUMENT` 并附 `allowed`/`field` 细节；**没有任何路径可以跳过它**。
- **20 个 operation**：`library.list`、`template.get`、`draft.create/open/applyOps/save/validate`、
  `review.submit/decide`、`revision.open`、`publish`、`publish.revision`、`proposal.list`、`version.get`、
  `compare`、`fork`、`deprecate`、`archive`、`run.create`、`run.snapshot`。
- **preload 只暴露一个方法**：`workflowRequest(request)`；`ipcRenderer` 永不外泄；暴露对象冻结。
- main.ts 首次调用时**惰性**打开治理数据库（`chains: ['core','engine','lifecycle']`）；打开失败会以
  结构化错误回给渲染层，而不是让外壳崩溃。

## 3. ChangeOp Coverage

`applyChangeOps(graph, ops)`（Core，纯函数）支持：`ADD_STAGE`、`REMOVE_STAGE`、`UPDATE_STAGE`、
`CONNECT_STAGE`、`DISCONNECT_STAGE`、`SET_ROLE`、`SET_VALIDATOR`、`SET_RISK`、`SET_APPROVAL`。

- **不可变**：返回全新对象图，输入逐字节不变（测试断言 JSON 快照相等）；
- **确定性**：同输入必同输出（无时钟/随机/IO/DB/React）；
- **原子**：批处理遇首个非法 op 立即返回错误并附 `opIndex`/`op`，**不返回半成品**；
- **明确错误**：重复 Stage ID / 空 ID / 未知 Stage / 自连 / 重复连线 / 缺失连线 / 空 role /
  非法 validator 列表 / 非法 risk / 非法 approval（含 `authority` 缺失）/ 未知 op 各有精确 `DomainError`；
- `REMOVE_STAGE` 会连带删除相关 Edge（不产生悬空引用）。

前置条件：只有 `draft` 可编辑（`assertEditable`：`published` → `ILLEGAL_TRANSITION`、
`deprecated` → `DEPRECATED_TEMPLATE`、`archived` → `ARCHIVED_READONLY`）。

## 4. Graph Validation

`validateWorkflowGraph(graph, options)` 一次报出全部问题，`assertPublishable` 是 Publish 门：

| 检查 | 问题码 |
|---|---|
| 有 Stage | `NO_STAGES` |
| Stage ID 唯一 | `DUPLICATE_STAGE_ID` |
| Edge 引用存在（无悬空） | `DANGLING_EDGE` |
| 无自环 | `SELF_LOOP` |
| 有起始 Stage | `NO_ENTRY_STAGE` |
| 有终止路径 | `NO_TERMINAL_STAGE` |
| 从起点可达 | `UNREACHABLE_STAGE` |
| 绑定 Role（可选强制） | `MISSING_ROLE` / `UNKNOWN_ROLE` |
| Validator 合法 | `UNKNOWN_VALIDATOR` |
| Risk 合法 + HIGH/CRITICAL 必须审批 | `INVALID_RISK` / `INVALID_APPROVAL` |
| 生命周期可编辑 | `LIFECYCLE_READONLY` |

Validation FAIL ⇒ **禁止 Publish**（`VALIDATION_FAILED`，附 `issueCodes` 与完整 issues）。
应用层在 `draft.applyOps`、`draft.save`、`publish` 三处执行该门（不是只在 UI 上提示）。

## 5. Workflow Library

展示：Name · Industry Pack（V1 无 pack 选择，显示 `generic`）· Current Version · Lifecycle State ·
Usage Count（由 `runs` 聚合，无数据为 0）· Last Updated。
操作：Open · Create Draft · Fork · Compare · Deprecate · Archive（+ Compare 结果表）。
不做 Metrics Dashboard。

## 6. Version / Fork / Proposal UX

- **Published 只读展示**：`draft.open` 返回 `editable=false` 并给出只读原因（proposal/fork 指引）；
  表单与删除/连线按钮在该状态下不渲染。**只读只是 UX；真正的拒绝来自 Core/Lifecycle**（测试 G）。
- **修改已发布模板**：`review.submit`（Change Proposal，需 ≥10 字理由）→ 另一人 `review.decide` accept
  （作者不可自批）→ `revision.open`（草案图）→ `publish.revision`（新版本）。
- **Fork**：`fork` 生成新 `draft` 模板（保留 lineage），源模板不变。
- **Compare**：`compare(fromVersionId, toVersionId)` → 纯 `diffGraphs`（新增/删除/变更的 Stage 与 Edge）。
- **Deprecate / Archive**：`deprecate` 后新 Run 被拒（`DEPRECATED_TEMPLATE`），旧 Run 继续；
  `archive` 后一切写入被拒（`ARCHIVED_READONLY`），仍可读。

## 7. Run Snapshot Regression

E2E（`apps/desktop/tests/workflows.test.ts` 的 N 组）：Run 绑定 v1.0 → Designer 走
Proposal → accept → revision → publish 出 v1.1 → 断言：旧 Run 仍 `versionId = v1.0`、
`run.snapshot` 返回的 `workflowVersionId` 仍是 v1.0 且 `verifyRunSnapshot` 通过；
新 `run.create` 绑定 v1.1。

## 8. 测试

| # | 场景 | 位置 |
|---|---|---|
| C/D | ChangeOp 确定性 + 非法拒绝 + 原子失败 + 不可变 | `packages/core/tests/lifecycle/change-ops.test.ts` |
| E | 图校验全部检查 + Publish 门 | `packages/core/tests/lifecycle/graph-validation.test.ts` |
| A/B | Draft 创建 / 修改（含非法 op set 不落库） | `apps/desktop/tests/workflows.test.ts` |
| F/G | Published 只读 + 绕过 UI 仍被拒 | 同上 |
| H/I/J/K/L/M | Fork / Proposal / Publish / Compare / Deprecated / Archived | 同上 |
| N | Run Snapshot 回归 | 同上 |
| Q | IPC schema 校验（每类非法输入 → `INVALID_ARGUMENT`） | 同上 |
| R | 重启后 Draft / Version / Library 一致 | 同上 |
| O/P | Renderer 无 SQLite、无规则复制；单一通道；唯一入口 | `tests/sprint5/designer-boundary.test.ts` |

## 9. 已知限制

- 无拖拽/画布/自动布局（按 §8 要求刻意省略）；
- `ChangeOp`（Proposal 的 ops）仍是记录性质，未被自动应用到图上：修订图由 Designer 显式提交；
- Industry Pack 列在 V1 固定显示 `generic`（pack 绑定属后续 Sprint）；
- 授权（谁可以 publish/archive）仍由 Core 的职责分离与后续 Role 存储承担；
- Renderer 无端到端浏览器测试（Electron 二进制在本环境无法下载），边界与模型层由单测覆盖。
