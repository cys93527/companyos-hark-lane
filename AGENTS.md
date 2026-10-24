# AGENTS.md — CompanyOS 施工守则（Agent 与人类工程师共同适用）

> 本文件是**每一轮 Agent 工作的入口契约**。配套文档：`docs/PROJECT_CONSTITUTION.md`（产品宪法）、
> `docs/WORKSPACE_GOVERNANCE.md`（工作区治理）、`docs/CORE_BOUNDARIES.md`（架构边界）、
> `docs/EXECUTION_ROADMAP.md`（执行路线）、`docs/INDEX.md`（文档地图）。
> 冲突时：以 `最终1.1.txt` 规划书为准 → 其次本文件 → 其次 §0.1 的单一真相源优先级。

## 0. 产品一句话

CompanyOS 是一个**按行业 SOP 组织多个可替换 AI 模型、Agent 与真实工具，协同完成业务目标的
AI 工作操作系统**。它不是多模型聊天器，也不是模型切换器。

**模型是员工。Agent 是岗位。Tool 是生产工具。Workflow 是 SOP。用户是老板。**

## 0.1 单一真相源（Single Source of Truth——不可谈判）

| 主题 | 唯一真相源 | 其他文档的角色 |
|---|---|---|
| 产品与总体规划 | **`PRODUCT_PLAN.md`** | `docs/PRODUCT_VISION.md`、`docs/MVP_SCOPE.md` 只能展开，不得改写结论 |
| 技术架构 | **`docs/ARCHITECTURE.md`** | `docs/CORE_BOUNDARIES.md` 细化边界；`docs/ARCHITECTURE_REVIEW.md` 只做评审 |
| Sprint 执行 | **`docs/EXECUTION_ROADMAP.md`** | `docs/SPRINT_0_TASKS.md` 等只细化单个 Sprint |
| 当前运行状态 | **`PROJECT_HANDOFF.md`** | 每轮工作开始时先读它；每轮结束时必须更新它 |
| 不可随意推翻的架构决策 | **`docs/adr/*.md`** | 见 `docs/DECISION_SYSTEM.md`；推翻必须走 Change Proposal |
| 代码内事实 | **`packages/*/src/**`、`packages/*/tests/**`** | 文档与代码冲突时**以代码为准**，并立即同步文档 |
| 状态机 | **`packages/core/src/domain/**` 的机器实现 + `docs/STATE_MACHINE.md`（镜像）** | 两者必须同改 |

**规则**：禁止多个文档同时定义相互冲突的同一条规则。发现冲突时：

1. **不得自行猜测**；
2. 按上表优先级裁定，高优先级文档胜出；
3. 把裁定写入 `docs/adr/`（架构级）或 `docs/DECISION_SYSTEM.md`（其他），字段至少包含
   `rationale` / `alternatives` / `frozenAreas` / `revisitWhen`；
4. 同步修正低优先级文档，并在 `PROJECT_HANDOFF.md` 记录该次裁定。

## 1. 架构法（不可谈判）

### 1.1 词汇法

`@companyos/core` 与 `@companyos/contracts` 中**不得出现**以下行业名词（作为标识符、类型名、
函数名、字段名或文件名）：

| # | 禁止词 | 归属 | 应使用的中性词 |
|---|---|---|---|
| 1 | `Coding` | Industry Pack | Work / Task / Assignment |
| 2 | `Git` | Industry Pack | Versioned artifact store |
| 3 | `Repository` | Industry Pack | **`EntityStore`** |
| 4 | `Developer` | Industry Pack | WorkRole / Contributor |
| 5 | `CTO` | Industry Pack | RoleArchetype |
| 6 | `Article` | Industry Pack | WorkProduct |
| 7 | `Video` | Industry Pack | MediaAsset |
| 8 | `Ecommerce` | Industry Pack | DomainPack capability |

### 1.2 命名特别规定

**持久化端口叫 `EntityStore`，永远不叫 `Repository`。** Core 的 23 个概念里没有 Repository
（核心词表见 ADR-0002；`Workflow Draft` 属模板生命周期层，不计入该 23 项词表）。

### 1.3 方向法

依赖只能向内：`core / contracts / observability` ← `persistence` ← `apps`，`packs/*` 依赖 Core，
**Core 永不依赖 Pack**。`@companyos/core` 必须保持**零运行时依赖**。

### 1.4 自动化门（违反即 CI 红）

- `node scripts/check-boundaries.mjs` — 词汇法 + 方向法
- `pnpm lint` — ESLint `no-restricted-syntax` / `no-restricted-imports`
- `packages/core/tests/sprint0-guardrails.test.ts`、`packages/core/tests/domain/*` — 禁止项与领域不变量

### 1.5 工作区治理（单一 Writer 规则）

- **同一 Workspace 同一时间最多只能有一个 Writer Agent。**
- **Reviewer 默认只读**：不得写入任何文件（包括"顺手修一下"）。
- **QA 默认只读**：除测试产生的临时文件（临时目录、被 `.gitignore` 覆盖的产物）外不得修改源码。
- 未来若需多个 Writer 并行，**必须使用独立 Git Worktree**，禁止共享同一工作目录。
- 违反判定：同一工作区出现来源不明的修改 → **立即停止写入**，先 `git status` / `git diff`
  列出全部差异并判断来源，交用户裁决。
- **禁止**用 `git reset --hard` / `git clean -fd` 掩盖差异（除非获得明确人工批准）。

完整规则、隔离方案与仲裁流程见 `docs/WORKSPACE_GOVERNANCE.md`（ADR-0004）。

## 2. 优先级阶梯（冻结版）

> 依据：正式规划 V1.1（规划书 §五十八）+ 用户 STEP 3C 裁定。**本表为唯一优先级口径**，
> 其他文档（含 `.planning/CANONICAL_SPEC.md`）的优先级编号一律作废。

| 优先级 | 范围 |
|---|---|
| **P0** | Core · Workflow Lifecycle · Versioning · State · Persistence · Handoff · Recovery · Provider Abstraction · Security · Approval |
| **P1** | Model Registry · Router · Agent Runtime · Tool Registry · Validation · Risk · Memory · Decision · Artifact · DevCompany Pack |
| **P2** | Developer · Reviewer · QA · Git · Rework · Provider Failover · Desktop Workflow UI |
| **P3** | Metrics · Worktree · Parallel Agents · Workflow Optimization |
| **P4** | 其他 Industry Packs · Cloud · Marketplace · Team |

> 注：规划书 §五十八 的 P2 原文另含 `Workflow Library UI`，归入同一 UI 组（随 Desktop Workflow UI
> 一起在 Sprint 29 落地），不单列为一条。

## 3. 当前阶段与禁止项

**当前唯一真值**：Sprint 0–16 已关闭。Sprint 10A / 10B / 10B.1 / 10B.2 均为 **CLOSED**，
**Router 主线 CLOSED**；Sprint 11 Structured Handoff 为 **CLOSED**，**Handoff 主线 CLOSED**；
Sprint 12 Memory + Decision 亦为 **CLOSED**；Sprint 13（Artifact + Validation）、Sprint 14（Recovery）、
Sprint 15（Industry Pack Framework）与 Sprint 16（DevCompany Pack，tag `sprint-16`）亦为 **CLOSED**
（收口记录 `docs/SPRINT13_CLOSEOUT.md` / `docs/SPRINT14_CLOSEOUT.md` / `docs/SPRINT15_CLOSEOUT.md` /
`docs/SPRINT16_CLOSEOUT.md`）。当前**没有 active sprint**：下一 Sprint 为
Sprint 17（Repository Runtime），未获用户正式开工批准前不得进入；**禁止提前进入 Sprint 17+**，
禁止提前实现 Repository/Terminal/Git 可执行 runtime、生产 repo tools、Artifact Asset System、
Artifact Asset 产品化、Desktop UI 接入视图。

Router 与 Handoff 是已验收冻结面：Sprint 12 不得修改 Router v1 权重、selection semantics、fallback contract，
也不得让 Handoff 自动选择 next role/model、调用 Router、启动 Agent、推进 Workflow 或继续 Stage。
Router 不得破坏既有语义 —— MANUAL 用户指定 → Router **不得覆盖**；HYBRID → Router **只能在 policy
候选范围内**选；AUTO → Router 才可以完整自动选择；**Explicit User Choice 永远优先于 Router Recommendation**。

**Sprint 10A 历史冻结项（仅描述 10A 契约阶段；10B 后续实现已关闭）**：不得实现 `selectModel()`/`rankModels()` 执行 · 不得调 Provider ·
不得调 Agent Runtime · 不得执行自动 fallback · 禁止 LLM-as-Router · 禁止多模型投票 ·
不得修改 Policy/Benchmark/Registry 数据 · 被 Hard Filter 淘汰的模型**不得**通过高分复活。

**Sprint 11（Structured Handoff）已关闭并完成生产接线（tag `sprint-11.0.0`）**，冻结规则：
0. **生产接线（收口）**：`createHandoffService` 已在组合根装配（`handoffStore` 缺失即**显式失败**）；
   Handoff IPC 生产可达（`handoff.create/ready/accept/reject/cancel/get/listForTargetRole`）；
   六事件经 `defineEvent` + `events.append` **durable 落库**；`handoff` 行 + refs **同一 SQLite 事务**；
   **actor roles 由 `authz.assignmentsOf` 服务端派生**，客户端提交 `actorRoleIds/roles/roleMemberships/
   effectiveRoles/permissions/authorities` 一律 `INVALID_ARGUMENT`；`previousHandoff` **只能**由服务端
   从 durable ACCEPTED handoff 派生（客户端提交 `previousHandoff`/`previousHandoffText` 直接拒绝）。
1. **Handoff 边界**：`Handoff ≠ Chat History ≠ Memory ≠ Artifact ≠ Workflow Transition ≠ Agent Runtime`；
   它只承载结构化摘要 + 引用（artifact/decision/validation/execution）。
2. **Runtime 不决定 next role**：`toRoleId` 只能由 Workflow/Task/Application Layer 给出；
   Runtime 只消费 `handoffContextViewIfAccepted()` 生成的**有界** `previousHandoff`（仅 ACCEPTED）。
3. **ACCEPTED Handoff 不自动推进 Workflow**，也不启动下一个 Agent、不选 model、不选 tool。
4. **Handoff 不等于 Memory**：不做召回/嵌入/跨任务记忆；引用系统（Artifact/Decision/Validator）属后续 Sprint。
5. **terminal version 内容不可原地改写**：`ACCEPTED/REJECTED/SUPERSEDED/CANCELLED` 后
   `objective/summary/refs/risks/next action` 一律不可变（服务层 + 存储层条件 UPDATE 双保险）。
6. **supersede 通过新版本完成**：新 `handoffVersion` + `supersedes` 链；
   `REJECTED/ACCEPTED → SUPERSEDED` 是唯一合法的终态→终态迁移（只改 status）。

**文本文件编码硬规则（已发生三次损坏）**：**禁止**使用 PowerShell `Set-Content` / `Out-File` / `>` / `>>`
重写项目源码、测试、JSON、Markdown 等任何文本文件；只能使用**安全文件编辑工具**或
**显式 UTF-8 字节安全**的程序化写法，并在提交前扫描 `U+FFFD` 与 UTF-8 有效性（含 BOM 检查）。
**Sprint 10B / 10B.1 / 10B.2 已关闭**：`createDeterministicModelRouter()` 实现 `ModelRouterPort.recommend`
（`assertRouterRequestAllowed → applyHardFilters → rankCandidates → selectWinner → validateRecommendation → 审计`）；
10B.1 进一步把 Router 变为**可达、可审计、可持久化、可追溯**：组合根启用 `router` 迁移链、六个 `router.*` 事件
**durable** 落库（12 字段白名单）、`router.recommend` / `override.request` / `override.confirm` IPC
（客户端**只能**给 scope，禁止 `policyView`/`candidateModels`/`allowedModels`/`blockedModels`/`allowedProviders`）、
`registryRevisionOf(records)` 内容绑定 revision、真实 provider health（unknown 不默认 healthy）、
decision 有界持久化（top-20 + `truncated`）、重启可追溯；**事务语义为“非原子”**（decision 先 → event 后 +
`reconcileAndRepairRouterAudit` **启动对账**（幂等补发，补发事件打标 `reconciled: true` / `repairReason`）），
**不得声称原子**。10B.2 另冻结：`totalCandidateCount`（进入 Router 的候选）与 `eligibleCandidateCount`（硬过滤后）
两个字段语义、provider health 5 分钟新鲜度（过期降级 `unknown`）、Run/Stage 仅为**上下文 id**（policy scope 只有
COMPANY/WORKFLOW/ROLE/TASK）、IPC forbidden-key 只有**一个**校验入口。
**仍然禁止**：Router 调 Provider · Router 调 Agent Runtime · Router 执行 fallback · LLM-as-Router ·
多模型投票 · 动态调权/在线学习 · 真实厂商 API · Tool Planner · DevCompany。
`自动 Tool Planner` / `无限 Tool Loop` / `DevCompany` 仍未进入。

### 3.1 历史 Sprint 范围记录（非当前 active instruction）

以下 Sprint 9/8/7 段落保留用于解释当时的边界与验收证据；其中“只允许”“仍然禁止”“尚未进入”等措辞
只描述对应 Sprint 的历史时点，**不得覆盖本节开头的当前唯一真值**。
更早的 Sprint 0 历史禁止范围包括 Model Router、Agent Runtime、DevCompany、Coding Agent、
Workflow Designer 与多模型调度；该记录同样不改变当前 active sprint。

Sprint 9 只允许：Tool Registry（`ToolRecord` 契约 + `ToolPort` 端口 + 注册/启停/读取 + `tool.*` 五个 authority +
风险分级与审批 + 双向 schema 校验 + 幂等 + 审计 + 独立迁移链）、确定性 MockTool、Agent Runtime 的
**一次受控工具轮**；Sprint 9.1 只允许：恢复语义、幂等索引化、重放诚实性、列表分页、descriptor 进 PromptPlan、
HIGH 自批规则的显式化。**Tool Registry 不是 Tool Planner（冻结）**：`invoke` 必须点名 `toolId`。

Sprint 8 只允许：Agent Execution Runtime（接收 Task/Role/明确 modelKey → 组装 AgentContext → 确定性
PromptAssembler → ProviderRegistry.invoke → InvocationResult → AgentExecution → Result/Artifact）、
独立的 Agent Execution 状态机、七类 `agent.*` 审计事件、第七条校验和迁移链、
`MODEL_SELECTION_REQUIRED` 错误语义、崩溃恢复（INTERRUPTED，绝不 COMPLETED、绝不重放）。

**Runtime 不选模型（冻结）**：`Role ≠ Agent ≠ Model ≠ Provider`，`Runtime ≠ Router`。
无明确 `modelKey` 时必须返回 `MODEL_SELECTION_REQUIRED`。仍然禁止：
`Model Router` · `自动选模型` · `scoreModel` · `rankModels` · `bestModel` · `自动 fallback` ·
`多模型协作` · `自动 Tool Planner` · `无限 Tool Loop` · `DevCompany` · `Coding Agent` ·
`AI 自动生成 Workflow` · 真实厂商 API · `真实生产 Tool` · `云端同步` · `多人协同`。
证据：`tests/sprint8/runtime-boundary.test.ts`、`docs/adr/0012-agent-runtime-and-model-binding.md`。

Sprint 7 只允许：`ModelRegistry`（策展层）+ `ModelRecord` + Provider Binding + Logical Alias +
Capability Profile + Context Window + Pricing + Availability + Health + Enable/Disable +
Streaming/结构化输出/工具调用/Vision 能力声明 + Max Output Tokens + 元数据持久化 + 重启保留 +
最小 Registry UI；并关闭 Sprint 6 三项欠账（授权执行点、分类上下文估算、Provider 审计事件）。

**Model Registry 不是 Model Router**——以下在 Sprint 7 及之后仍然禁止（出现即违规，必须回退）：
`自动选模型` · `模型评分路由` · `fallback` · `Model Router` · 真实 `Agent Runtime` · 真实厂商 API 调用 ·
`DevCompany` · `Coding Agent` · `多模型调度` · `AI 自动生成 Workflow` · `多人协同` · `云端同步`。
`docs/MODEL_REGISTRY.md` 与 `docs/adr/0010-model-registry-and-no-routing.md` 记录该边界与证据；
`tests/sprint7/registry-boundary.test.ts` 断言源码与 DDL 中没有 score/rank/priority/fallback。

**密钥铁律（不可谈判）**：API Key 不得进入 Git / Log / Event / Handoff / SQLite 明文 / Error details；
数据库只能存 `SecretRef` 指针（`secret_refs` 表没有值列）；结果若含密钥一律**拒绝返回**，不做"打洞"。
**厂商铁律**：厂商 Adapter 只能位于**外环**；`packages/core/src`、`packages/engine/src`、
`packages/persistence/src`、`apps/*/src` 中出现任何厂商名（含注释与字符串）即违规。
证据：`tests/sprint6/boundary.test.ts`。

## 4. 每个 Sprint 的完成定义（DoD）

```powershell
git status --porcelain            # 必须为空（基线冻结）
pnpm install --frozen-lockfile    # Exit Code 0
pnpm check                        # lint → typecheck → boundaries → test → build，必须 Exit Code 0
pnpm test:scripts                 # node --test：边界门、仓库卫生、聚合门自检
```

外加：文档更新、`PROJECT_HANDOFF.md` 更新、Independent Review、一次提交、无禁止项代码。
**不得通过 `skip` / `only` / 删除测试来制造 PASS；测试数量只能增加。**

## 5. 工作纪律

1. **一次只做一个 Sprint。** 禁止一口气做到 Sprint 30。
2. Plan → Implement → Test → Independent Review → Commit → Update Handoff。
3. 已发布的 Workflow Template **禁止原地修改**：Change Proposal → Fork → Draft → 测试 →
   Review → Publish 新版本。
4. 真实结果优先于 AI 自述：以 Exit Code、Diff、Tool Result 为准。
5. 决策必须落盘（`docs/DECISION_SYSTEM.md` / `docs/adr/`），后续模型不得反复推翻已验证的决策。
6. 秘密（token/密码/密钥）永不入库、永不进日志、永不进记忆。
7. 单一 Writer（§1.5）：同一工作区不得并发写入；需要并行就用独立 Git Worktree。

## 6. 升级与降级规则

- 发现产品方向问题 → 停止实现，先写 Change Proposal / Decision Record，交给用户裁决。
- 发现 Core 被污染（出现行业名词）→ 立即回退到 Pack 层，并跑边界门自证。
- 遇到阻塞 → 在 `PROJECT_HANDOFF.md` 的「Open Risks / Known Limitations」记录，不要静默绕过。
- 发现文档冲突 → 按 §0.1 裁定并记录，不得两套规则并存。

## 7. 文档地图

见 `docs/INDEX.md`。所有设计文档必须能追溯到规划书章节（形如「规划书 §五十九」）。
