# ADR-0002：Core Domain 词表冻结（23 概念）与 Port 边界冻结

> 归属：规划书 §四（Core 只认识的概念）、§六十六 STEP 2/STEP 3、用户 STEP 3A / STEP 5 Task 1 / Task 7。

## 状态

**已接受（Accepted）** — Sprint 1 起点生效，Sprint 1 Task 1 与 Task 7 的交付物。

## 背景

1. 规划书 §四 逐一列出 Core 允许认识的概念；此前重建文档与任务简报误写为「24 个」，
   经逐行核对（规划书第 447–491 行）**原文为 23 个**：Company、Industry Pack、Workflow、
   Workflow Template、Workflow Version、Workflow Run、Stage、Task、Role、Agent、Artifact、Tool、
   Validation、Approval、Risk、Event、Memory、Decision、Handoff、Provider、Model、Capability、Cost。
2. 同节列出 Core **禁止**写死的行业名词：`Coding`、`Git`、`Repository`、`CTO`、`Developer`、
   `Article`、`Video`、`Ecommerce`——它们属于 Industry Pack。
3. 端口此前是「重建规格」推导出的临时签名（`Clock`/`IdFactory`/`Logger`/`EventBus`/`EntityStore`/
   `MigrationRunner`/`SecretResolver`/`ModelGateway`/`AgentRuntime`），既未冻结，也缺少
   执行与事件持久化两个必然要用的端口（开源调研 §10.3 已标出该缺口）。

## 决策

### 1. Core 词表冻结为 23 项

- 以 `packages/core/src/domain/catalog.ts` 的 `CORE_CONCEPTS` 常量作为**机器可读的唯一词表**；
- 逐项标注 `owner`（哪个有界上下文实现它）与 `sprint`（何时落地）；
- `packages/core/tests/domain/catalog.test.ts` 锁定：数量恰为 23、无重复、无行业禁词、
  且每一项都在 `CORE_CONCEPTS` 中有明确归属；
- 所有文档（`PRODUCT_PLAN.md`、`AGENTS.md`、`docs/*`）只能引用该数字，**不得再出现 24**。

### 2. Port 边界冻结为 11 个

| # | Port | 语义 | 状态 |
|---|---|---|---|
| 1 | `Clock` | 可注入时间（禁止 `Date.now()` 直调） | 冻结（Sprint 0 已实现） |
| 2 | `IdFactory` | ULID / 前缀 id 生成 | 冻结（Sprint 0 已实现） |
| 3 | `Logger` | 结构化日志 | 冻结（Sprint 0 已实现） |
| 4 | `EventBus` | 领域事件分发 | 冻结（Sprint 0 仅契约） |
| 5 | `EntityStore<T>` | 实体持久化（**永不叫 Repository**） | 冻结（Sprint 0 已实现） |
| 6 | `MigrationRunner` | 迁移执行与校验 | 冻结（Sprint 0 已实现） |
| 7 | `SecretResolver` | 秘密解析（钥匙串） | 冻结（Sprint 0 仅契约） |
| 8 | `ModelGateway` | 模型调用 | 冻结（仅类型，实现属 P1/Sprint 7） |
| 9 | `AgentRuntimePort` | Agent 执行 | 冻结（仅类型，实现属 P1/Sprint 8） |
| 10 | `WorkflowEnginePort` | 按 Run 执行 Stage/Task（**新增**，补调研 §10.3 缺口） | 冻结（仅类型） |
| 11 | `EventStorePort` | 事件追加与回放（**新增**，审计与恢复的前提） | 冻结（仅类型） |

约束：

- Core 端口签名**只能**出现 Core 自有类型（`Result<T, E>`、品牌化 id、Core DTO）；
  **不得**出现任何框架类型名（如 `Agent`（框架语义）、`StateGraph`、`Crew`、`Run`（框架语义）等）；
- 新增/修改端口必须走本 ADR 的修订流程（Change Proposal + 新 ADR 版本），不得就地改动；
- `@companyos/core` 的 `dependencies` 与 `devDependencies` 恒为空（由边界门与测试双重强制）；
- **授权与绑定由外环注入、Core 只做校验**（Sprint 1 评审补充）：
  - `ApprovalDecision.authorities` 必须由外环从 `Role.authority` 解析后传入，Core **不信任调用方自述**
    （`decideApproval` 只校验其中是否含 `run.approve`）；
  - `Agent.modelBindingRef` 只接受逻辑绑定（`logical.<slot>[.<tier>]`，slot 与 tier 均为闭集），
    provider/model 名称由 Router 在运行期解析，**永不进入 Core 数据**。

## 后果

**收益**：Core 的"能说什么"与"能调用什么"都变成可测试的事实；行业 Pack 无法再腐蚀 Core；
文档与代码之间的词表漂移有了自动门。

**代价**：端口冻结意味着 Sprint 1 之后任何端口变更都要走提案流程；`WorkflowEnginePort`/
`EventStorePort` 的签名是**前瞻性设计**，Sprint 2/3 落地时若发现不适配，需按流程修订并记录。

**被否决方案**：

| 方案 | 否决理由 |
|---|---|
| 不冻结，让端口随实现演进 | 与规划书原则 6（Orchestrator 是制度）冲突；端口漂移会让 Pack 与 adapter 无法稳定编程 |
| 把端口清单放进文档而不放进代码 | 文档无法被 CI 强制，必然漂移 |
| 把 `WorkflowEngine` 留到 Sprint 2 再定 | 执行路径是 Sprint 1 领域模型（Run/Stage/Task）的直接消费方，先冻结才能避免领域模型被实现细节反向塑形 |

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | Sprint 1 | 初版：23 概念词表 + 11 端口冻结 |
