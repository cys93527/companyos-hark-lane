# 真实规划书 V1.1 与重建规格的对账

> **权威来源（唯一）**：`最终1.1.txt` —— CompanyOS 最终可执行项目规划书 V1.1，3530 行，本章简称「规划书」。
> **对照物（仅参考，不得当权威）**：`.planning/CANONICAL_SPEC.md`（基于空文件重建）及 `docs/ARCHITECTURE.md`、`docs/CORE_BOUNDARIES.md`、`docs/WORKFLOW_LIFECYCLE.md`、`docs/ARCHITECTURE_REVIEW.md`、`docs/SPRINT_0_TASKS.md`（同源重建）。
> **处置口径**：以规划书为准。凡重建说法与规划书冲突的，一律**修正**；规划书要求而重建缺失的，**新增任务**；两者一致的，**保留**。

## 对账结论摘要（最重要的三项差异）

1. **状态机层次错位**：重建文档把 `draft / published / deprecated / archived` 四态当作 CompanyOS 的主状态机；规划书 §三十三 的主状态机是 **17 个全局状态**（IDLE … RECOVERING），那四态只是规划书 §六/§七 的 **Template 生命周期**，是不同层次、必须分层。
2. **优先级与 Sprint 结构完全不同**：重建路线图是 11 个 Sprint、Model Router / Agent Runtime 被定为 **P2 且排在 Sprint 7/8**；规划书是 **31 个 Sprint**（§五十九），且 §五十八 把 Router、Agent Runtime、Tool Registry、Model Registry、DevCompany Pack 全部定为 **P1**，只有 Developer / Reviewer / QA / Git / Rework / Provider Failover / Desktop UI 才是 P2。旧优先级表必须整体作废重写。
3. **大量无依据补充被当成规格**：ADR-0001…ADR-0012 编号体系、`EntityStore` 端口命名、「9 个端口」清单、`packs/{devcompany,article,video,ecommerce}` 四包映射、`packages/{ipc,pack-sdk,platform,adapters/*}` 包名、`p50/p95DurationMs` 等指标口径，规划书里**都不存在**；其中四包映射还与规划书 §五十三「MVP 明确不做 ContentCompany / VideoStudio / EcommerceCompany」直接冲突。

## 对账方法

| 项 | 做法 |
|---|---|
| 权威判定 | 只以 `最终1.1.txt` 的章节原文为准；重建文档只用于「找出与规划书的差异」，不作为依据。 |
| 读取方式 | 规划书全文分段读完（1–900 / 901–1800 / 1801–2700 / 2701–3530），逐节核对。 |
| 覆盖范围 | §四 · §六/§七 · §十 · §十一 · §十二 · §十五 · §十七–§二十二 · §二十八 · §三十三 · §三十七 · §四十三 · §五十二 · §五十三 · §五十五 · §五十六 · §五十八 · §五十九 · §六十 · §六十一 · §六十六。 |
| 差异分级 | **冲突**（说法矛盾，必须改）· **缺失**（规划书有、重建无，新增任务）· **补充**（规划书无、重建自创，须标注为工程补充而非规范）· **一致**（保留）。 |
| 计数规则 | 所有条目数均按规划书原文逐行点算；**任务简报与规划书原文计数不一致处，以规划书为准并在此标注**（例如 §四 概念数）。 |
| 禁止事项 | 不写真实 commit hash；不编造通过率 / 成本 / 日期数据；不确定处写「待 Sprint N 验证」。 |
| 仓库状态时点 | 仓库正被并行工作改动。本对账的仓库事实以**核对时点**为准：`AGENTS.md` / `README.md` / `.github/` / `scripts/tests/` / `packages/core/tests/` / `docs/OPEN_SOURCE_RESEARCH.md` 在核对时**已存在**，而 `PROJECT_HANDOFF.md` / `docs/INDEX.md` / `docs/adr/` / `docs/PRODUCT_CONSTITUTION.md` 等**仍不存在**。后续改动不改变规划书侧的任何结论。 |
| 输出物 | 本对账文档 + `docs/EXECUTION_ROADMAP.md`（31 Sprint 版）。本次仅写这两个文件。 |

## 术语与实体对账

### §四 Core 词表（禁词 + 24 / 23 计数差异）

| 项 | 规划书 §四 原文 | 计数 |
|---|---|---|
| Core 禁词 | Coding · Git · Repository · CTO · Developer · Article · Video · Ecommerce | **8 个** |
| Core 只认识的概念 | Company · Industry Pack · Workflow · Workflow Template · Workflow Version · Workflow Run · Stage · Task · Role · Agent · Artifact · Tool · Validation · Approval · Risk · Event · Memory · Decision · Handoff · Provider · Model · Capability · Cost | **23 个** |

> **计数差异（必须记录）**：任务简报与仓库根 `AGENTS.md` §1.2 都写「Core 的 **24** 个概念」，但规划书 §四 原文逐一列出的是 **23 个**（第 447–491 行）。本对账**以规划书为准：23 个**。若把规划书 §六/§七 才出现的 `Workflow Draft` 计入则为 24，但 §四 原文未列该概念。`AGENTS.md` 的这句话需改为「Core 的 23 个概念里没有 Repository（`Workflow Draft` 属模板生命周期，不计入 §四 词表）」。

**逐概念对账**（旧规格 = `.planning/CANONICAL_SPEC.md` §3 的七个限界上下文 + `docs/ARCHITECTURE.md` §5）：

| # | 规划书 §四 概念 | 重建规格中的对应物 | 处置 |
|---|---|---|---|
| 1 | Company | 无（只有 `OrgUnit` / `orgId`） | **新增任务**：Core 需显式 `Company` 聚合 |
| 2 | Industry Pack | 只有 `IndustryPack` / `PackManifest`（`docs/ARCHITECTURE.md` §4） | **保留**（命名一致，需作为一等实体） |
| 3 | Workflow | `WorkflowTemplate` / node graph（`NodeExecution`） | **修正**：Workflow 与 Workflow Template 须分层，不能混为一物 |
| 4 | Workflow Template | `WorkflowTemplate` | **保留** |
| 5 | Workflow Version | `WorkflowVersion` | **保留** |
| 6 | Workflow Run | `Run` | **修正**：统一命名为 `WorkflowRun` / `workflow_runs`（§五十六） |
| 7 | Stage | 无（用 `node` / `NodeExecution` 代替） | **新增任务**：Stage 是规划书的一等概念 |
| 8 | Task | 无独立 Task 聚合（`taskRef` 只是字段） | **新增任务**：Task 需为实体（§五十六 `tasks` 表） |
| 9 | Role | `RoleArchetype` / `WorkRole` | **保留**（规划书角色即岗位，与模型解耦） |
| 10 | Agent | 只有 `AgentRuntime` 端口，无 `Agent` 实体 | **新增任务**：`Agent` 实体 + `agents` 表 |
| 11 | Artifact | `WorkProduct` + `contentRef`（无 Artifact 实体） | **修正**：Use `Artifact`（§五十六 `artifacts` 表） |
| 12 | Tool | `ToolAdapter`（契约式） | **修正**：统一为 `Tool` + `tools` 表（§五十六） |
| 13 | Validation | 无实体（只有 `ValidationResult` 概念，未建表） | **新增任务**：`Validation` 实体 + `validations` 表 |
| 14 | Approval | `Approval` 聚合（Governance） | **保留** |
| 15 | Risk | 无实体（只有 `Policy` / `Budget`） | **新增任务**：`Risk` 四级（§三十六、§三十七） |
| 16 | Event | `EventEnvelope`（类型见 §四十三） | **修正**：事件类型名改按 §四十三 的 SCREAMING_SNAKE |
| 17 | Memory | `MemoryRecord` + 四 scope | **保留**（四层记忆对应 §二十九，见 `docs/MEMORY_ARCHITECTURE.md`） |
| 18 | Decision | 无 | **新增任务**：`Decision` / Decision Record（§三十） |
| 19 | Handoff | `HandoffEnvelope` | **修正**：字段必须按 §二十八 的 22 字段清单（本表后文） |
| 20 | Provider | 无实体（只有 `ModelGateway` 端口） | **新增任务**：Provider 层（§四十、§四十一） |
| 21 | Model | 无实体 | **新增任务**：Model Registry（§二十四） |
| 22 | Capability | `CapabilityDescriptor` | **保留** |
| 23 | Cost | 只有 `Budget`（限额），无成本记录实体 | **新增任务**：Cost Engine（§四十二）+ `cost_records` 表 |

**禁词对账**：8 个禁词在规划书 §四 与 §六十六 STEP 2 中完全一致，重建文档也已列举同样 8 个 → **保留**，继续作为 Core 边界强制项。

### §三十三 全局状态机（17 态）与 Template 生命周期（4 态）的分层

规划书 §三十三 的 17 个全局状态：

```text
IDLE · INITIALIZING · DESIGNING_WORKFLOW · WORKFLOW_REVIEW · WORKFLOW_PUBLISHED
PLANNING · ROUTING · WAITING_APPROVAL · EXECUTING · REVIEWING · VALIDATING
REWORK · FINALIZING · COMPLETED · FAILED · PAUSED · RECOVERING
```

规划书 §六/§七 的 Template 生命周期（**另一层次**）：`DRAFT` · `PUBLISHED` · `RUNNING` · `DEPRECATED` · `ARCHIVED` · `FORKED`。

**分层结论（这是重建文档最大的结构性错误）**：

| 层次 | 状态集 | 出处 | 语义 | 重建文档的处理 | 处置 |
|---|---|---|---|---|---|
| **L1 全局运行状态** | §三十三 的 17 态 | 规划书 §三十三 | 「这家公司/这次业务现在处于什么阶段」，覆盖从 IDLE 到 RECOVERING 的全过程 | **完全缺失**，被四态取代 | **新增任务**：新增全局状态机，17 态齐全 |
| **L2 Workflow Template 生命周期** | `draft / published / deprecated / archived`（+ `forked` 变体） | 规划书 §六 · §七 | 「这套 SOP 本身处于什么成熟度」，只管模板，不管某次执行 | 被当成唯一主状态机（`docs/STATE_MACHINE.md` §2、`docs/WORKFLOW_LIFECYCLE.md` §3） | **修正**：降为模板层子状态机，并改名以消歧（见下） |
| **L3 本次执行态** | `RUNNING / DEPRECATED…` 之外的执行细节（Stage 级、Task 级） | 规划书 §三十四 标准执行生命周期 | 单次 Run 内部的阶段推进 | 用 `RunState` 8 态自创（`queued/running/paused/waiting_handoff/succeeded/failed/cancelled/timed_out`） | **补充标注**：可作为执行层实现，但不得替代 L1 的 17 态 |

**命名冲突**：L1 有 `WORKFLOW_PUBLISHED`，L2 有 `published` —— 两者同名不同义。**处置**：L1 一律用 §三十三 的全大写常量，L2 一律用全小写状态字面量；文档与代码不得混用。

**逐态对账（17 态）**：

| 全局状态 | 重建文档中的对应物 | 处置 |
|---|---|---|
| IDLE | 无 | 新增任务 |
| INITIALIZING | 无 | 新增任务 |
| DESIGNING_WORKFLOW | 无（Designer 只是 UI 需求） | 新增任务 |
| WORKFLOW_REVIEW | 无 | 新增任务 |
| WORKFLOW_PUBLISHED | 误用 L2 的 `published` | 修正（分层，见上） |
| PLANNING | 无 | 新增任务 |
| ROUTING | 无（Router 被推到 P2 / Sprint 7） | 修正优先级 + 新增任务 |
| WAITING_APPROVAL | 近似 `HandoffState` / 审批挂起 | 修正为全局态 |
| EXECUTING | 近似 `RunState.running` | 修正为全局态 |
| REVIEWING | 无 | 新增任务 |
| VALIDATING | 无 | 新增任务 |
| REWORK | 无（Rework 只作为 P2 功能点） | 新增任务 |
| FINALIZING | 无 | 新增任务 |
| COMPLETED | 近似 `RunState.succeeded` | 修正为全局态 |
| FAILED | 近似 `RunState.failed` | 修正为全局态 |
| PAUSED | 近似 `RunState.paused` | 修正为全局态 |
| RECOVERING | 无（§9.5 只描述行为，没有状态） | 新增任务 |

### §十七–§二十二 DevCompany 角色

| 规划书节 | 角色 | 职责要点 | 重建文档 | 处置 |
|---|---|---|---|---|
| §十七 | MVP 只做 5 个角色 | Chief / CTO · Developer · Reviewer · QA · Documentation | 只有 CTO / Developer / Reviewer / QA + Reviewer Archetype | **新增任务**：补 **Documentation** 角色 |
| §十八 | Chief / CTO | 理解需求 / 分析现有项目 / 选或设计 Workflow / 定义 Sprint / Task / Acceptance Criteria / Capability Requirement / 判风险 / 最终验收 / 提 SOP 优化建议；**不负责持续调度** | 有 CTO archetype，但无「定义 Sprint / 最终验收 / 优化建议」职责 | **修正**：补全职责清单 |
| §十九 | Developer | 编码 / UI / API / CRUD / Bug Fix / 普通重构 / 测试补充 / 文件修改 | 有 Developer archetype | **保留**（补职责清单） |
| §二十 | Reviewer | Code Review / 架构一致性 / 潜在 Bug / 边界 / 状态一致 / 并发 / 异步 / 安全 / 测试不足 / 无关 Diff；**默认与 Developer 用不同模型** | 有 Reviewer；**无「默认不同模型」这条硬约束** | **修正**：加入 Router 验收 |
| §二十一 | QA | 用真实工具跑 tests / lint / typecheck / build / git diff / git status；**事实来自真实结果，不是 LLM 自述** | 有 QA；无 6 项工具清单 | **修正**：明确 6 项命令 |
| §二十二 | Documentation | README / API Docs / CHANGELOG / User Guide / Technical Documentation / Decision Summary | **缺失** | **新增任务** |

### §二十八 Handoff JSON 字段清单（22 字段）

规划书 §二十八 原文顺序的 22 个字段：

| # | 规划书字段 | 重建 `HandoffEnvelope` 对应 | 处置 |
|---|---|---|---|
| 1 | `workflowId` | 无 | **新增任务** |
| 2 | `workflowVersion` | 无（分散在 RunSnapshot） | **新增任务** |
| 3 | `workflowRunId` | `runId` | **修正命名** |
| 4 | `taskId` | `taskRef` | **修正命名** |
| 5 | `stageId` | 无 | **新增任务** |
| 6 | `objective` | 无 | **新增任务** |
| 7 | `role` | 无（只有 `fromRole` / `toRole`） | **新增任务** |
| 8 | `previousAgent` | `fromRole` | **修正**（是 Agent 不是 Role） |
| 9 | `nextRole` | `toRole` | **保留**（改名） |
| 10 | `provider` | 无 | **新增任务** |
| 11 | `model` | 无 | **新增任务** |
| 12 | `risk` | 无 | **新增任务** |
| 13 | `context` | `payload` | **修正** |
| 14 | `constraints` | 无 | **新增任务** |
| 15 | `acceptanceCriteria` | 无 | **新增任务** |
| 16 | `artifacts` | 无 | **新增任务** |
| 17 | `decisions` | 无 | **新增任务** |
| 18 | `validationResults` | 无 | **新增任务** |
| 19 | `reviewFindings` | 无 | **新增任务** |
| 20 | `knownRisks` | 无 | **新增任务** |
| 21 | `nextAction` | 无 | **新增任务** |
| 22 | `status` | 无（有独立 `HandoffState` 机） | **修正**：进 Handoff JSON |

**要点**：重建的 9 字段信封（`{id, fromRole, toRole, runId, taskRef, payloadSchema, payload, deadline?, idempotencyKey}`）**缺少 14 个规划书字段**；幂等键与 deadline 是重建补充（可保留为实现细节，但不能替换 §二十八 的字段清单）。规划书 §二 原则 8/9 与 §二十八 明确：Agent 之间禁止主要依赖聊天上下文，必须结构化交接。

### §十二 性能指标（14 项）

| # | 规划书 §十二 指标 | 重建 `WorkflowMetrics` 字段 | 处置 |
|---|---|---|---|
| 1 | 运行次数 | `runCount` | **保留** |
| 2 | 成功率 | `successRate` | **保留** |
| 3 | 失败率 | 无（只有成功率） | **新增任务** |
| 4 | 平均完成时间 | `p50DurationMs` / `p95DurationMs`（口径不同） | **修正**：改按「平均完成时间」，百分位属重建补充 |
| 5 | 平均成本 | `costUsd` | **保留**（改名对齐） |
| 6 | 平均 Token | `tokensIn` / `tokensOut` | **保留**（改名对齐） |
| 7 | 平均返工次数 | 无 | **新增任务** |
| 8 | 人工介入率 | `humanInterventions`（是计数，不是率） | **修正**：指标为「率」 |
| 9 | 最容易失败的 Stage | `nodeFailureRates{}`（按 node，不是 Stage） | **修正**：按 Stage 统计 |
| 10 | 最慢 Stage | 无 | **新增任务** |
| 11 | 最贵 Stage | 无 | **新增任务** |
| 12 | 常用模型 | 无 | **新增任务** |
| 13 | Reviewer 退回率 | 无 | **新增任务** |
| 14 | 最终用户满意度 | 无 | **新增任务** |

**处置**：重建的 `cancellationRate` / `costPerSuccessfulRun` / `window=90 天` / `nearest-rank 百分位` 等口径属**无依据补充**，可保留为实现细节，但必须显式标注，且不得挤占上述 14 项。首份真实指标值待 Sprint 27 验证（不预填数字）。

### §三十七 DevCompany 高风险操作

| 级别 | 规划书 §三十七 清单 | 重建文档 | 处置 |
|---|---|---|---|
| **HIGH**（执行前审批） | Database Migration · Authentication · Payment · Concurrency · Core State · Architecture Rewrite · Large Refactor · Major Dependency Upgrade（**8 项**） | 无该清单；「HIGH」在旧文档里是**评审发现严重度**（BLOCKER/HIGH/MEDIUM/LOW） | **新增任务** + **消歧**：操作风险等级 ≠ 评审严重度，术语必须区分 |
| **CRITICAL**（强制明确确认） | Production Database · Mass Delete · Force Push · Secret Changes · Production Deployment（**5 项**） | 无 | **新增任务** |

对应规划书 §三十六 的四级策略：LOW 自动 · MEDIUM 自动 + 强制 Review · HIGH 执行前审批 · CRITICAL 强制明确确认。

### §四十三 事件类型（22 个）

规划书 §四十三 原文：

```text
WORKFLOW_DRAFT_CREATED · WORKFLOW_PUBLISHED · WORKFLOW_FORKED · WORKFLOW_DEPRECATED
WORKFLOW_RUN_CREATED · WORKFLOW_STARTED · STAGE_STARTED · TASK_CREATED
MODEL_SELECTED · AGENT_ASSIGNED · TOOL_CALLED · ARTIFACT_CREATED
REVIEW_STARTED · REVIEW_FAILED · VALIDATION_STARTED · VALIDATION_FAILED
REWORK_STARTED · APPROVAL_REQUIRED · TASK_COMPLETED
RUN_INTERRUPTED · RUN_RECOVERED · WORKFLOW_COMPLETED
```

| 项 | 重建文档的事件命名 | 处置 |
|---|---|---|
| 命名风格 | PascalCase（`WorkflowPublished`，`docs/ARCHITECTURE.md` §5.8）与 dotted lowercase（`workflow.template.published`，已落地代码）并存 | **修正**：统一为规划书 §四十三 的 SCREAMING_SNAKE；两套旧风格都作废 |
| 覆盖度 | 重建事件表缺少 `MODEL_SELECTED` / `AGENT_ASSIGNED` / `TOOL_CALLED` / `TASK_CREATED` / `STAGE_STARTED` / `REWORK_STARTED` / `APPROVAL_REQUIRED` / `RUN_INTERRUPTED` / `RUN_RECOVERED` / `WORKFLOW_STARTED` 等 | **新增任务**：22 个事件全部落表并进 `events` 表 |
| 重建补充事件 | `WorkflowVersionMinted` / `TemplateLockAcquired` / `ChangeProposalOpened` / `RunQueued` / `HandoffAcked` 等 | **补充标注**：可作为领域内部事件保留，但不得替代 §四十三 的 22 个「至少包括」类型 |

### §五十六 数据库表清单

| 分组 | 规划书 §五十六 表名 | 计数 |
|---|---|---|
| Core 核心表 | `companies` · `industry_packs` · `workflow_templates` · `workflow_template_versions` · `workflow_drafts` · `workflow_runs` · `workflow_stage_definitions` · `workflow_role_bindings` · `workflow_tool_bindings` · `workflow_validators` · `workflow_risk_rules` · `workflow_change_requests` · `workflow_performance_metrics` · `tasks` · `roles` · `agents` · `providers` · `models` · `capabilities` · `tools` · `handoffs` · `memories` · `decisions` · `artifacts` · `validations` · `events` · `approvals` · `cost_records` · `settings` | **29** |
| DevCompany 专属表 | `repositories` · `git_checkpoints` · `test_results` | **3** |

| 规划书表名 | 重建 `docs/STATE_MACHINE.md` §10 表名 | 处置 |
|---|---|---|
| `workflow_runs` | `runs` | **修正**：改用规划书命名 |
| `workflow_template_versions` | `workflow_versions` | **修正** |
| `workflow_change_requests` | `change_proposals` | **修正** |
| `workflow_performance_metrics` | `workflow_metrics` | **修正** |
| — | `workflow_fork_lineage` · `template_locks` · `run_snapshots` · `node_executions` · `handoff_outbox` · `handoff_dedupe` · `audit_log` · `schema_migrations` | **补充标注**：规划书未列，属工程实现补充；其中 `run_snapshots` 对应 §十一 的 Run Snapshot（概念必须保留，表名可自定） |
| `companies` / `industry_packs` / `workflow_drafts` / `workflow_stage_definitions` / `workflow_role_bindings` / `workflow_tool_bindings` / `workflow_validators` / `workflow_risk_rules` / `tasks` / `roles` / `agents` / `providers` / `models` / `capabilities` / `tools` / `handoffs` / `memories` / `decisions` / `artifacts` / `validations` / `events` / `approvals` / `cost_records` / `settings` | **缺失** | **新增任务**：Sprint 3 建表 |

规划书 §五十六 同时要求启用 WAL · Foreign Keys · Transactions · Migrations —— 与重建的技术选择（`node:sqlite` + WAL + 编号迁移）**一致**，属工程实现层补充，**保留**。

### §五十五 目录结构 ↔ 仓库当前布局

**规划书 §五十五 推荐目录**：

```text
apps/desktop
packages/core/{orchestrator, workflow, workflow-lifecycle, workflow-versioning,
               state-machine, scheduler, risk, approval, recovery}
packages/{agent-runtime, agent-registry, model-registry, tool-registry}
packages/providers/{core, openai, anthropic, deepseek, openai-compatible}
packages/protocol/{task, handoff, event, artifact, validation, decision, workflow}
packages/{memory, persistence/sqlite, security, observability, cost}
packages/packs/dev-company
packages/shared
tests/  docs/  AGENTS.md  PROJECT_HANDOFF.md  PRODUCT_PLAN.md
```

**仓库当前实际布局**：`packages/{core, contracts, observability, persistence}`、`apps/{desktop, renderer}`、`scripts/{check-boundaries.mjs, check.mjs, clean.mjs}`、`packages/core/src/{kernel, lifecycle, ports, registry}`、`docs/`（10 份）、`.planning/CANONICAL_SPEC.md`。

| 规划书 §五十五 路径 | 仓库现状 | 映射 / 处置 |
|---|---|---|
| `apps/desktop` | ✅ `apps/desktop` | **保留**。规划书未列 `apps/renderer`，但 §四十八/§五十四 明确 Electron + React + Vite，故 `apps/renderer` 属合理实现细分 → **保留并标注为补充** |
| `packages/core/orchestrator` | ❌ 无（`core/src` 只有 `kernel`/`lifecycle`/`ports`/`registry`） | **新增任务**：Orchestrator 是 §二 原则 6「制度不是 AI」的承载体，必须显式成型 |
| `packages/core/workflow` · `workflow-lifecycle` · `workflow-versioning` | ⚠️ 部分：`core/src/lifecycle/{machine,template,version,lock,proposal,snapshot,metrics,change-proposal,proposal-diff,template-lock}.ts` | **修正**：按规划书切分 `workflow` / `workflow-lifecycle` / `workflow-versioning` 三块 |
| `packages/core/state-machine` | ⚠️ 部分：`core/src/lifecycle/machine.ts`（只有 4 态模板机） | **新增任务**：新增 §三十三 的 17 态全局状态机 |
| `packages/core/scheduler` | ❌ 无 | **新增任务**（对应 §二 原则 6 的 Concurrency 管理） |
| `packages/core/risk` · `approval` · `recovery` | ❌ 无（Risk/Approval/Recovery 只在文档层） | **新增任务**（§三十六、§三十七、§四十五） |
| `packages/agent-runtime` | ❌ 无（仅 `core/src/ports/agent-runtime.ts` 端口） | **新增任务**：Sprint 8 |
| `packages/agent-registry` | ❌ 无 | **新增任务** |
| `packages/model-registry` | ❌ 无 | **新增任务**：Sprint 7 |
| `packages/tool-registry` | ❌ 无 | **新增任务**：Sprint 9 |
| `packages/providers/{core,openai,anthropic,deepseek,openai-compatible}` | ❌ 无 | **新增任务**：Sprint 6 |
| `packages/protocol/{task,handoff,event,artifact,validation,decision,workflow}` | ⚠️ 部分：`packages/contracts` 承担了协议职责 | **修正**：`protocol/` 子域需拆分；`contracts` 为重建自创包名（**补充标注**） |
| `packages/memory` | ❌ 无 | **新增任务**：Sprint 12 |
| `packages/persistence/sqlite` | ⚠️ `packages/persistence`（无 `sqlite` 子目录） | **修正**：补 `sqlite` 子目录以对齐 |
| `packages/security` | ❌ 无（安全散落在 `docs/SECURITY_MODEL.md`） | **新增任务** |
| `packages/observability` | ✅ `packages/observability` | **保留**（与规划书一致） |
| `packages/cost` | ❌ 无 | **新增任务**：Sprint 27 / Cost Engine（§四十二） |
| `packages/packs/dev-company` | ❌ 无（无 `packs/` 目录） | **新增任务**：Sprint 16。注意规划书是 `packages/packs/dev-company`，重建文档写 `packs/devcompany` → **修正路径** |
| `packages/shared` | ❌ 无（由 `packages/contracts` 代偿） | **修正**：按规划书新增 `shared`，或明确以 `contracts` 取代并记录为补充 |
| `AGENTS.md` · `PROJECT_HANDOFF.md` · `PRODUCT_PLAN.md`（仓库根） | ⚠️ 核对时点：`AGENTS.md` **已存在**；`PROJECT_HANDOFF.md` / `PRODUCT_PLAN.md` **不存在** | **新增任务**：Sprint 0 收尾必须补齐 `PROJECT_HANDOFF.md`；`PRODUCT_PLAN.md` 可并入既有产品文档并记录 |
| `tests/` | ⚠️ 无顶层 `tests/`，但有 `scripts/tests/` 与 `packages/core/tests/`（核对时点） | **补充标注**：包内 + 脚本自检可保留；规划书的 `tests/` 若指集成/E2E 目录，需在 Sprint 30 前补 |

### §五十二 MVP 必须实现 vs §五十三 MVP 明确不做

**规划书 §五十二「必须实现」共 27 项**：CompanyOS Core · Workflow Lifecycle · Workflow Template · Workflow Version · Workflow Run Snapshot · Workflow Metrics 基础 · DevCompany Pack · Workflow Engine · Orchestrator · State Machine · Provider Layer · Model Registry · Capability System · Model Router · Agent Runtime · Tool Registry · Handoff · Memory · Decision Record · Artifact · Validation · Risk · Approval · Events · Recovery · Cost · Desktop UI。

**规划书 §五十三「明确不做」共 14 项**：正式 ContentCompany · VideoStudio · EcommerceCompany · Cloud SaaS · Multi-user · Team Collaboration · Marketplace · Mobile · 复杂 RAG · Vector Database · Agent Farm · Kubernetes · 自动生产部署 · 超复杂并行 Agent。

| 争议点 | 重建文档的说法 | 规划书 | 处置 |
|---|---|---|---|
| Model Router 属于哪一档 | 归 **P2**，排在 Sprint 7 | §五十二 列为 MVP **必须实现**；§五十八 归 **P1**；§五十九 排在 **Sprint 10** | **修正**：优先级与排期全面改为 P1 / Sprint 10 |
| Agent Runtime 属于哪一档 | 归 **P2**，排在 Sprint 8 | §五十二 必须实现；§五十八 归 **P1**；§五十九 排在 **Sprint 8** | **修正**：优先级改 P1（排期恰好也是 Sprint 8，属巧合） |
| Provider Layer | 未在旧路线图中单独排期 | §五十八 归 **P0**（Provider Abstraction）；§五十九 **Sprint 6** | **新增任务** |
| DevCompany | 归 P3，Sprint 9 | §五十八 归 **P1**；§五十九 **Sprint 16** | **修正** |
| Developer / Reviewer / QA / Git / Rework | 归 P3（含在 DevCompany Pack 内） | §五十八 归 **P2**；§五十九 **Sprint 19–23** | **修正** |
| Article / Video / Ecommerce Pack | 列为 P3 交付物（Sprint 10） | §五十三 **明确不做**；§六十二 待 Core 验证后再做第二行业 | **删除**：MVP 阶段不得排期这四个 Pack |
| Workflow Designer | 归 P3，Sprint 10 | §四十九 是新增核心界面，但 §五十八 未单列；按「Desktop Workflow UI」= **P2** | **修正**：优先级 P2（Sprint 5 仍可作为前置） |
| Vector Database / 复杂 RAG | 列入 P1 记忆实现 | §五十三 **明确不做** | **修正**：Memory 只做 §二十九 四层记忆，不含向量库 |

**与 Sprint 0「只做基础设施」的关系（必须一起读）**：

| 概念 | 含义 | 与 Sprint 0 的关系 |
|---|---|---|
| 规划书 §五十二 MVP 必须实现（27 项） | **整个 MVP（Sprint 0–30 累计）** 必须最终实现的东西 | **不是** Sprint 0 的范围。它解释「为什么 Model Router / Agent Runtime 终归要做」，不授权 Sprint 0 去做 |
| 规划书 §五十三 MVP 明确不做（14 项） | 明确**不做**的东西（正式第二行业、云、多云、多用户、市场、移动端等） | 与 Sprint 0 无冲突；这些项永不出现在 Sprint 0–30 的排期里 |
| 重建文档的「Sprint 0 禁做清单」 | Model Router · Agent Runtime · DevCompany · Coding Agent · Workflow Designer · 多模型调度 | **与规划书不冲突**：这是**阶段纪律**（Sprint 0 只做底座），不是「这些东西属于 P2」的优先级判定 |
| 重建文档的「P2 锁定」 | 把 Router / Runtime / DevCompany 定为 P2 并锁在 Sprint 7–9 | **冲突**：§五十二 说它们必须做，§五十八 说它们属 P1/P2（分项），§五十九 给了明确 Sprint 号 | **修正**：保留「Sprint 0 禁做」，废除「Router = P2」的优先级判定 |

> **一句话结论**：Sprint 0 的禁做清单**保留**；但它的理由必须写成「本 Sprint 只做基础设施」，而不是「这些能力属于 P2」。§五十二 是累计范围，§五十三 是永久排除项，§五十九 是阶段排期 —— 三者层次不同，不得互相替代。

### §六十一 架构终极验收（重建文档完全缺失）

| 项 | 规划书 §六十一 要求 | 重建文档 | 处置 |
|---|---|---|---|
| 前提 | DevCompany MVP 完成后，**禁止大改 Core** | 无 | **新增任务** |
| 动作 | 新增一个 **Mock ContentCompany Pack**：Workflow `Plan → Write → Review → Deliver`；角色 `Content Director` · `Writer` · `Reviewer` | 无 | **新增任务**（Sprint 30 / Phase 4 出口验收） |
| 判据 | 若**仅新增 Pack** 即可实现 → 说明 **Core 行业抽象成功**；若**需要修改大量 Core** → 必须**回头修复架构** | 无 | **新增任务**：作为可执行的验收测试 |
| 与 §五十三 的关系 | 「Mock」不是「正式 ContentCompany」（§五十三 明确不做正式 ContentCompany；§六十二 才是 Core 验证后的正式第二行业） | — | **消歧**：Mock Pack 是架构验收手段，不违反 §五十三 |

## 差异清单

| # | 重建说法 | 真实规划书说法 | 处置 |
|---|---|---|---|
| 1 | 主状态机 = `draft/published/deprecated/archived`（`docs/STATE_MACHINE.md` §2） | §三十三 主状态机 = **17 个全局状态**（IDLE…RECOVERING）；四态是 §六/§七 的 Template 生命周期 | **修正**：分层，新增 17 态全局机 |
| 2 | 重建路线图共 **11 个 Sprint**，Sprint 11 出 v1.1.0 | §五十九 共 **31 个 Sprint**（Sprint 0–30），Sprint 30 = MVP Hardening | **修正**：整个路线图重写为 31 Sprint |
| 3 | Phase 0 = Sprint 0–2（含 Persistence）；Phase 1 = Sprint 3–6 | 规划书未定义 Phase；Sprint 编号连续 0–30，验收逐 Sprint 给出 | **修正**：Phase 仅作分组视图，且必须与 Sprint 编号对齐（0 / 1–4 / 5–15 / 16–26 / 27–30） |
| 4 | Model Router = **P2**，Sprint 7 | §五十八 Router = **P1**；§五十九 Sprint 10 | **修正** |
| 5 | Agent Runtime = **P2**，Sprint 8 | §五十八 Agent Runtime = **P1**；§五十九 Sprint 8 | **修正**（优先级） |
| 6 | DevCompany Pack = **P3**，Sprint 9 | §五十八 DevCompany Pack = **P1**；§五十九 Sprint 16 | **修正** |
| 7 | Developer / Reviewer / QA / Git / Rework = P3 子项 | §五十八 各自为独立 **P2** 条目；§五十九 Sprint 19–23 | **修正** |
| 8 | Article / Video / Ecommerce Pack 为 P3 交付物 | §五十三 **明确不做**；§六十二 第二行业在 Core 验证后 | **删除**该排期 |
| 9 | 生命周期能力写成 **10 项**，并配 ADR-0001…ADR-0012 编号 | 规划书**没有 ADR 体系**；§六十六 STEP 3 要求审查 Workflow 是否支持 Draft / Publish / Version / Fork / Deprecate / Run Snapshot / Template Lock / Performance Metrics / Change Proposal（**9 项**）；§五十九 Sprint 4 另列 Draft / Review / Publish / Version / Fork / Deprecate / Archive / Run Snapshot / Template Lock（**9 项**） | **修正**：删去 ADR 编号体系（或明确标注为工程补充）；以 §六十六 STEP 3 + §五十九 Sprint 4 的合集为准（Draft · Review · Publish · Version · Fork · Deprecate · Archive · Run Snapshot · Template Lock · Performance Metrics · Change Proposal） |
| 10 | 持久化端口命名为 `EntityStore`，并称「`Repository` 是 Core 禁词」；该命名已被仓库根 `AGENTS.md` §1.2 采纳为**强制**约定 | §四 禁词含 **Repository**，但规划书**从未定义任何端口名**，也没有 `EntityStore`；§五十六 中 `repositories` 是 **DevCompany 专属表** | **修正**：端口命名属工程实现细节（可保留为仓库约定），但**不得**写成规划书要求；文档须改为「规划书只约束禁词（Repository 不得作为 Core 标识符），端口名自定」。`AGENTS.md` 的强制条款可保留，但依据应写成「工程约定」，而非「规划书规定」 |
| 11 | 「9 个端口」全集（Clock / IdFactory / Logger / EventBus / EntityStore / MigrationRunner / SecretResolver / ModelGateway / AgentRuntime） | 规划书无端口清单；§四十 只给了 `ModelProvider` 接口（healthCheck / listModels / run / stream） | **补充标注**：端口清单为工程补充；`ModelProvider` 4 方法是规划书原文要求 → **新增任务** |
| 12 | 包映射 `packs/{devcompany, article, video, ecommerce}` + `packages/{ipc, pack-sdk, platform, adapters/persistence, adapters/platform}` | §五十五 是 `packages/packs/dev-company` 等固定结构，且**没有** ipc / pack-sdk / platform / adapters 命名 | **修正**：按 §五十五 结构重排；重建包名保留时须标注为补充 |
| 13 | `WorkflowMetrics` 字段含 `p50DurationMs` / `p95DurationMs` / `cancellationRate` / `costPerSuccessfulRun` / `nodeFailureRates{}` | §十二 是 **14 项**指标（运行次数 / 成功率 / 失败率 / 平均完成时间 / 平均成本 / 平均 Token / 平均返工次数 / 人工介入率 / 最容易失败的 Stage / 最慢 Stage / 最贵 Stage / 常用模型 / Reviewer 退回率 / 最终用户满意度），**无百分位、无取消率** | **修正**：14 项必做；百分位等标注为补充 |
| 14 | `HandoffEnvelope` 9 字段 | §二十八 **22 字段** | **修正**：按 22 字段重建 |
| 15 | 事件命名 PascalCase 或 dotted lowercase | §四十三 **22 个 SCREAMING_SNAKE 事件** | **修正** |
| 16 | 表名 `runs` / `workflow_versions` / `change_proposals` / `workflow_metrics` | §五十六 `workflow_runs` / `workflow_template_versions` / `workflow_change_requests` / `workflow_performance_metrics` | **修正** |
| 17 | 无 §三十七 高风险操作清单；「HIGH」是评审严重度 | §三十七 操作风险 HIGH **8 项** + CRITICAL **5 项** | **新增任务** + 术语消歧 |
| 18 | 无 §六十一 架构终极验收 | §六十一 Mock ContentCompany Pack 判定 Core 抽象成功 | **新增任务** |
| 19 | DevCompany 只有 4 个角色（CTO / Developer / Reviewer / QA） | §十七 MVP 是 **5 个**角色，含 **Documentation** | **新增任务** |
| 20 | 记忆含「向量库 / 复杂 RAG」 | §五十三 明确不做 Vector Database / 复杂 RAG；§二十九 只要四层记忆 | **删除**该技术项 |
| 21 | 称 Sprint 0 已交付（11 任务 12 端口），并写「Phase 0 已交付」 | §五十九 Sprint 0 验收 = `pnpm check` Exit Code 0；§六十六 STEP 1 要求 16 份文档，STEP 8 要求 Commit + 更新 PROJECT_HANDOFF.md | **修正**：核对时点 `AGENTS.md` / `README.md` / `.github/` / `scripts/tests/` / `packages/core/tests/` 已存在，但 `PROJECT_HANDOFF.md` / `docs/INDEX.md` / `docs/adr/` 仍缺，`pnpm check` Exit Code 0 未验证 → Sprint 0 **未闭合** |
| 22 | Phase 3 = 「Industry Packs」，出口是 DevCompany 驱动编码 SOP | §五十九 Sprint 16–26 是「DevCompany Pack → Repository Runtime → CTO → Developer → Reviewer → QA → Rework → Git Commit → Approval → Failover → Crash Recovery」 | **修正**：Phase 3 主题改为 DevCompany 全链路 |
| 23 | 重建文档的归档路径 `docs/adr/ADR-00NN-*.md`、`scripts/boundary-allowlist.json` | 规划书无 ADR 目录、无 boundary allow-list 概念 | **补充标注**：可保留为工程实践，不得当作规划书要求 |
| 24 | 重建 `CORE_BOUNDARIES.md` §4 的 `PackManifest` 字段表（manifestVersion / packId / coreApiRange / permissions / signature / license 等 20 字段） | §十五 只要求 Pack 定义 Roles / Workflow Templates / Prompts / Tools / Validators / Artifacts / Risk Rules / Capability Rules / Templates（**9 类内容**） | **修正**：以 §十五 九类为下限；`PackManifest` 字段表标注为补充 |

### 必须保留（重建文档中与规划书一致、不得丢弃的内容）

| # | 保留项 | 规划书依据 |
|---|---|---|
| 1 | Core 8 个禁词：Coding · Git · Repository · CTO · Developer · Article · Video · Ecommerce | §四 · §六十六 STEP 2 |
| 2 | 行业能力以 Pack 扩展，Pack 依赖 Core，Core 不依赖 Pack | §十五 · §六十八 |
| 3 | Template 生命周期四态语义：草稿不用于生产、Published 不可原地修改、Deprecated 停新建 Run 但旧 Run 继续、Archived 只读审计 | §六 · §七 · §十 |
| 4 | Run Snapshot：Run 创建时固定版本，模板升级不影响在跑 Run | §十一 · §六十 Case 3 |
| 5 | 版本化 SOP：v1.0 / v1.1 / v2.0 并存，禁止原地覆盖 | §九 · §十 |
| 6 | 跨模型 Handoff：模型换了任务不重来，禁止重开 Workflow、禁止要用户重新解释 | §二 原则 9 · §二十七 |
| 7 | 真实结果优先于 AI 自述（Exit Code / Artifact / Tool Result / Diff / Validation） | §二 原则 7 · §二十一 |
| 8 | 角色与模型彻底解耦（Role 是岗位，Model 是可替换劳动力） | §二 原则 3 · §二十三 |
| 9 | 四级风险策略（LOW 自动 / MEDIUM 自动 + Review / HIGH 审批 / CRITICAL 明确确认） | §三十六 · §五十一 |
| 10 | 自动返工闭环 + 默认最大 3 次，超限 PAUSED | §十 · §三十五 |
| 11 | 技术栈（§五十四）：Electron · React · TypeScript · Vite · Node.js · SQLite · Zod · Vitest · Playwright · Git CLI，且 **TypeScript First** | §五十四 |
| 12 | SQLite + WAL + Foreign Keys + Transactions + Migrations | §五十六 |
| 13 | 本地优先、单 Workspace、串行 Agent（V1）；Worktree/Docker/Remote 属后续 | §四十七 · §五十三 |
| 14 | 禁止直接修改生产 Template；修改须走 Proposal → Draft → Test → Review → Publish | §六十七 |
| 15 | 纪律：只执行 Sprint 0，禁止一次性做到 Sprint 30 | §六十六 STEP 6 |
| 16 | 每个 Sprint 有 Task / Acceptance Criteria / Tests / Git Checkpoint | §六十六 STEP 5 |
| 17 | 优先级阶梯 P0–P4（Core/Lifecycle/State Machine/Persistence/Handoff/Recovery/Provider Abstraction/Agent-Model 解耦/Security/Approval 为 P0；Model Registry/Router/Agent Runtime/Tool Registry/Validation/Risk/Memory/Decision/Artifact/DevCompany Pack 为 P1；Developer/Reviewer/QA/Git/Rework/Failover/Desktop UI/Workflow Library UI 为 P2；Metrics/自动绩效评分/Worktree/并行 Agent/优化建议 为 P3；其他行业 Pack/Cloud/Marketplace/Team 为 P4） | §五十八（**仓库根 `AGENTS.md` §2 与该阶梯逐项一致 → 该文件此节可保留并作为实现口径**） |
| 18 | 每个 Sprint 的 DoD 由真实命令证据构成（Exit Code / Diff / 测试结果），而非 Agent 自述 | §二 原则 7 · §二十一 · §四十四 |

**明确标注为「无依据补充」的清单**（可保留为实现细节或仓库约定，但必须显式标注、不得冒充规格）：ADR-0001…ADR-0012 编号体系 · `EntityStore` 端口命名与替换表（已被 `AGENTS.md` §1.2 采纳为仓库强制约定，但依据须写「工程约定」）· 「9 个端口」全集 · `packs/{devcompany,article,video,ecommerce}` 四包映射 · `packages/{ipc,pack-sdk,platform,adapters/*}` 包名 · `p50/p95DurationMs` 等指标口径 · `cancellationRate` / `costPerSuccessfulRun` / 90 天窗口 · `RunState` 8 态 · `WorkflowVersionState` / `TemplateLockState` / `HandoffState` / `NodeExecutionState` 等机器的细粒度转移表 · `ChangeProposal.consumed` 派生标志 · `ForkLineage` 表 · `handoff_outbox` / `handoff_dedupe` / `audit_log` / `template_locks` 表 · `boundary-allowlist.json` 与 ADR 目录 · 「10 项生命周期能力」的 10 这个数字本身 · `AGENTS.md` §1.1 的「应使用的中性词」一列（`Work / Task / Assignment` 等为该文件自定，规划书未规定）。

## 对现有代码与文档的影响

### 1. 对 `packages/core/src` 的影响

| 现状 | 问题 | 处置（新增任务，非本次改动） |
|---|---|---|
| `core/src/kernel/{errors,events,hash,ids,result}.ts` | 内核能力与规划书无冲突 | **保留**；`events.ts` 的事件类型需改按 §四十三 命名 |
| `core/src/lifecycle/machine.ts`（4 态模板机） | 被文档称为「the」状态机，且路径与重建 SPEC 不一致 | **修正**：明确它是 **L2 模板层**子机；另建 L1 的 17 态全局机 |
| `core/src/lifecycle/{template,version,lock,change-proposal,proposal,proposal-diff,template-lock,snapshot,metrics}.ts` | 覆盖 §六/§七/§十一 部分语义 | **保留**（作为 L2 实现），但需与新增的 §三十三 全局态、§五十六 表名对齐 |
| `core/src/ports/*`（9 个端口 + `store.ts`） | 端口命名为重建自创；`ModelGateway` / `AgentRuntime` 在 Sprint 0 只能是类型 | **保留**为工程实现，文档降级其权威性；`ModelProvider`（§四十 的 4 方法）需补 |
| `core/src/registry/pack-manifest.ts` | 字段表为重建自创（20 字段） | **修正**：以 §十五 九类内容为下限 |
| 缺失：`orchestrator` / `scheduler` / `risk` / `approval` / `recovery` / 17 态状态机 / `Company` / `Stage` / `Task` / `Agent` / `Tool` / `Validation` / `Decision` / `Cost` / `Provider` / `Model` | 规划书要求的一等概念缺位 | **新增任务**（Sprint 1、2、4、6、7、9、13、24、27） |

### 2. 对持久化的影响

- 表名需从重建命名改为规划书 §五十六 命名（`workflow_runs` / `workflow_template_versions` / `workflow_change_requests` / `workflow_performance_metrics` 等），并补齐 24 张缺失表 → **新增任务（Sprint 3）**。
- `workflow_drafts`（§五十六）与 `workflow_stage_definitions` / `workflow_role_bindings` / `workflow_tool_bindings` / `workflow_validators` / `workflow_risk_rules` 在重建 schema 中不存在 → **新增任务**。
- `repositories` / `git_checkpoints` / `test_results` 属 **DevCompany 层**，不得进 Core → 与禁词约束一致，**保留该约束**。
- WAL / Foreign Keys / Transactions / Migrations 与规划书一致 → **保留**。

### 3. 对文档的影响

| 文档 | 需要的动作 | 依据 |
|---|---|---|
| `docs/EXECUTION_ROADMAP.md` | **已重写**为 31 Sprint 版（本次交付） | §五十八 · §五十九 |
| `docs/V1_1_RECONCILIATION.md` | **本文件**（本次交付） | — |
| `.planning/CANONICAL_SPEC.md` | 需按本对账重写：删 ADR 体系、修正优先级、补 17 态全局机、补 23 概念词表、标注端口命名为补充 | §三十三 · §五十八 · §四 |
| `docs/ARCHITECTURE.md` | 需修正包映射（改为 §五十五）、事件命名、端口权威性、13（ii）端口清单 | §五十五 · §四十三 |
| `docs/CORE_BOUNDARIES.md` | 禁词部分**保留**；`EntityStore` 章节需改为「工程命名约定（非规划书要求）」；删 ADR-0001 的规格地位 | §四 · §六十六 STEP 2 |
| `docs/WORKFLOW_LIFECYCLE.md` | 需明确是 **L2 模板层**语义；四态不得再当全局态；10 项能力改按 §六十六 STEP 3 表述 | §六 · §七 · §三十三 |
| `docs/ARCHITECTURE_REVIEW.md` | ADR-0001…ADR-0012 需标注为工程补充；评审严重度 HIGH 与操作风险 HIGH 需消歧；gate 条件需对齐 §六十六 STEP 7/8 | §三十七 · §六十六 |
| `docs/SPRINT_0_TASKS.md` | 任务清单可用，但「9 端口 / EntityStore / ADR-0001」需标注为补充；Sprint 0 DoD 需对齐 `pnpm check` Exit Code 0 + 文档 + Commit + PROJECT_HANDOFF.md | §五十九 Sprint 0 · §六十六 STEP 7–8 |
| `docs/STATE_MACHINE.md` | 需分层：新增 §三十三 的 17 态全局机；现有 7 个机器降为 L2/L3 实现细节 | §三十三 |
| §六十六 STEP 1 要求但仓库**缺失**的文档（16 份中已存在 9 份，**缺 7 份**，核对时点） | `PRODUCT_VISION.md` · `PROJECT_CONSTITUTION.md` · `MVP_SCOPE.md` · `WORKFLOW_VERSIONING.md` · `WORKFLOW_METRICS.md` · `DECISION_SYSTEM.md` · `VALIDATION_SYSTEM.md`（`OPEN_SOURCE_RESEARCH.md` 已于核对时点存在） | **新增任务**（Sprint 0 收尾 / Sprint 1 前） |
| `AGENTS.md` 自身引用但**不存在**的文件 | `docs/PROJECT_CONSTITUTION.md`（其抬头声明的配套文档）· `docs/INDEX.md`（§7 文档地图指向）· `scripts/check-boundaries.mjs` 与 `packages/core/tests/sprint0-guardrails.test.ts`（§1.4 自动化门，其中后者核对时点已存在） | **新增任务**：补 `PROJECT_CONSTITUTION.md` 与 `docs/INDEX.md`，否则 `AGENTS.md` 的指向为悬空引用 |
| 仓库根缺失的文件 | `PROJECT_HANDOFF.md` · `PRODUCT_PLAN.md`（`AGENTS.md` 与 `README.md` 在核对时点已存在） | **新增任务**（§五十五 · §五十九 Sprint 0） |

### 4. Sprint 0 完成度核对（与「已交付」说法的冲突）

| Sprint 0 交付项（§五十九 / 重建 DoD） | 仓库现状 | 结论 |
|---|---|---|
| Monorepo | ✅ `pnpm-workspace.yaml` + 根 `package.json` | 已落地 |
| Electron / React / TypeScript | ✅ `apps/{desktop,renderer}` + `tsconfig.base.json` | 已落地 |
| SQLite / Migration | ✅ `packages/persistence` | 已落地 |
| Logging | ✅ `packages/observability` | 已落地 |
| Testing | ✅ `vitest.config.ts` + `scripts/tests/` + `packages/core/tests/`（核对时点） | 已落地 |
| CI | ✅ `.github/`（核对时点） | 已落地，待验证 `pnpm check` 是否为其门禁 |
| `AGENTS.md` | ✅ 已存在（含词汇法 / 优先级阶梯 P0–P4 / Sprint 0 禁止项 / DoD） | 已落地；其中「Core 的 24 个概念」与 `EntityStore` 强制命名两处需按本对账修正 |
| `PROJECT_HANDOFF.md` | ❌ 不存在 | **未落地** |
| `README.md` | ✅ 已存在（核对时点） | 已落地 |
| `pnpm check` Exit Code 0（§六十六 STEP 7 的硬验收） | 未验证（本次不得运行 pnpm / git / 构建命令） | **待 Sprint 0 收尾验证** |
| Git Commit + tag（§六十六 STEP 8） | 未验证 | **待 Sprint 0 收尾验证** |

> **结论**：Sprint 0 **尚未闭合**。重建文档中「Phase 0 / Sprint 0 已交付」的表述必须撤回，改为「Sprint 0 部分落地：Monorepo / Electron / React / TypeScript / SQLite / Migration / Logging / Testing / CI / `AGENTS.md` / `README.md` 已在核对时点出现；`PROJECT_HANDOFF.md` 仍缺，`pnpm check` Exit Code 0 与 Commit + tag 尚未验证」。

### 5. 本次对账的边界（未做的事）

- 本次只写 `docs/EXECUTION_ROADMAP.md` 与 `docs/V1_1_RECONCILIATION.md` 两个文件，**未修改任何代码、未修改其他文档、未运行 pnpm / git / 构建命令**。
- 上述所有「修正 / 新增任务 / 删除」均为**待执行清单**，逐项已挂到 `docs/EXECUTION_ROADMAP.md` 的对应 Sprint。
- 无法从规划书确定的数值（通过率、成本、耗时、日期、commit hash）一律未填；凡涉及实测处均标注「待 Sprint N 验证」。

---

## 冻结口径（FROZEN — Sprint 1 前生效，用户 STEP 3 裁定）

本节是本对账的**结论部分**：以下三项口径自此冻结，任何文档、代码、测试、注释都必须与之统一。
裁定记录见 `docs/adr/0002-core-domain-and-port-freeze.md`、`docs/adr/0003-state-layering.md`。

### A. Core Domain 数量 = 23（以正式规划 V1.1 为唯一真相源）

- 规划书 §四 原文逐一列出 **23 个**概念：Company、Industry Pack、Workflow、Workflow Template、
  Workflow Version、Workflow Run、Stage、Task、Role、Agent、Artifact、Tool、Validation、Approval、
  Risk、Event、Memory、Decision、Handoff、Provider、Model、Capability、Cost。
- 此前任务简报与本仓库早期文档出现的「**24**」为误记（把 §六/§七 才出现的 `Workflow Draft`
  错计为 §四 词表成员）。`Workflow Draft` 属**模板生命周期层**，不计入该 23 项。
- 强制方式：`packages/core/src/domain/catalog.ts` 的 `CORE_CONCEPTS` 常量 +
  `packages/core/tests/domain/catalog.test.ts`（数量必须为 23、无重复、无行业禁词）；
  文档侧由 `AGENTS.md` §1.2、`PRODUCT_PLAN.md` §3、`docs/STATE_MACHINE.md` 头部共同引用该数字。

### B. 状态分层 = 三层（禁止混用）

| 层 | 名称 | 状态集合 | 归属 |
|---|---|---|---|
| **L1** | Workflow Run / Execution State | `IDLE` · `INITIALIZING` · `DESIGNING_WORKFLOW` · `WORKFLOW_REVIEW` · `WORKFLOW_PUBLISHED` · `PLANNING` · `ROUTING` · `WAITING_APPROVAL` · `EXECUTING` · `REVIEWING` · `VALIDATING` · `REWORK` · `FINALIZING` · `COMPLETED` · `FAILED` · `PAUSED` · `RECOVERING`（**17 个**） | 规划书 §三十三 |
| **L2** | Workflow Template Lifecycle | `DRAFT` → `PUBLISHED` → `DEPRECATED` → `ARCHIVED`（4 个；`FORKED` 是血缘标记，`RUNNING` 是查询视图而非状态） | 规划书 §六 / §七 |
| **L3** | Task / Stage 局部态 | Stage：`PENDING`/`READY`/`ACTIVE`/`DONE`/`FAILED`/`SKIPPED`；Task：`PENDING`/`READY`/`RUNNING`/`BLOCKED`/`DONE`/`FAILED`/`CANCELLED`/`SKIPPED`；节点/交接/提案/锁各自的子机 | 实现细节 |

**禁止**再把 Template Lifecycle 与 Execution State 混成一套状态机。Sprint 0 文档中的 8 态运行词表
（`queued`/`running`/`paused`/`waiting_handoff`/`succeeded`/`failed`/`cancelled`/`timed_out`）
**已被取代**，映射关系见 ADR-0003 §取代关系；`cancelled` / `timed_out` 不再单列状态，
其语义记录在 `FAILED` 的 `reason` 与事件中。

### C. 优先级 = 冻结阶梯（以正式规划 V1.1 为唯一依据）

| 优先级 | 范围 |
|---|---|
| **P0** | Core · Workflow Lifecycle · Versioning · State · Persistence · Handoff · Recovery · Provider Abstraction · Security · Approval |
| **P1** | Model Registry · Router · Agent Runtime · Tool Registry · Validation · Risk · Memory · Decision · Artifact · DevCompany Pack |
| **P2** | Developer · Reviewer · QA · Git · Rework · Provider Failover · Desktop Workflow UI |
| **P3** | Metrics · Worktree · Parallel Agents · Workflow Optimization |
| **P4** | 其他 Industry Packs · Cloud · Marketplace · Team |

冲突处置：`.planning/CANONICAL_SPEC.md` §5 的 P1–P4 编号（Router/Agent Runtime = P2）
**作废**；`docs/EXECUTION_ROADMAP.md` 的映射表、`AGENTS.md` §2 已按上表重写；
规划书 §五十八 的 P2 原文另含 `Workflow Library UI`，归入 Desktop Workflow UI 一组。

### D. 与本对账其余章节的关系

本文件前四节（对账方法 / 术语与实体对账 / 差异清单 / 对现有代码与文档的影响）保留为
**分析过程记录**；凡与前四节结论冲突处，**以本节（冻结口径）为准**。
