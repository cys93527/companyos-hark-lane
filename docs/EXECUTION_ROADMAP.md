# CompanyOS 执行路线图（Execution Roadmap）

> **权威来源**：真实规划书 V1.1《CompanyOS 最终可执行项目规划书》（3530 行）。
> Sprint 名称与验收取自「规划书 §五十九」；优先级取自「规划书 §五十八」；执行纪律取自「规划书 §六十六」；架构终极验收取自「规划书 §六十一」。
> **状态**：已按真实规划书重写；此前基于空文件重建的旧路线图作废，逐项对账见 `docs/V1_1_RECONCILIATION.md`。
> **禁止项**：本文档不写真实 commit hash（只写 tag 名），不写未采集的成功率 / 成本 / 日期等实测数字（未验证处写「待 Sprint N 验证」）。
> **当前执行状态**：Sprint 0–13 已关闭；Router 主线、Handoff 主线均为 **CLOSED**；Sprint 12
> 已完成收口；Sprint 13（Artifact + Validation）已完成 12 个 Task 与最终收口（tag `sprint-13.0.0`，
> 收口记录见 `docs/SPRINT13_CLOSEOUT.md`）。Sprint 14（Recovery）已完成全部 6 个 Task 与最终收口
>（tag `sprint-14.0.0`，收口记录见 `docs/SPRINT14_CLOSEOUT.md`）。Sprint 15（Industry Pack
> Framework）架构已冻结（Task-15-01，ADR-0024~0027 Accepted，`docs/sprint15/`）；实现未开始，
> 未经批准不得开工。

## Phase 总览

| Phase | Sprint 范围 | 数量 | 优先级 | 目标 | 出口标准 |
|---|---|---|---|---|---|
| **Phase 0** | Sprint 0 | 1 | **P0** | 工程底座：Monorepo · Electron · React · TypeScript · SQLite · Migration · Logging · Testing · CI · AGENTS.md · PROJECT_HANDOFF.md | `pnpm check` Exit Code 0（规划书 §五十九 Sprint 0 验收） |
| **Phase 1** | Sprint 1–4 | 4 | **P0** | Core Domain（§四 词表实体）+ Workflow Engine（状态机 / Transition / Retry / Pause / Resume / Loop / Branch / Failure / Approval）+ 全量持久化 + Workflow Lifecycle（Draft/Review/Publish/Version/Fork/Deprecate/Archive/Run Snapshot/Template Lock） | Published Template 不能直接修改；旧 Run 不受新版本影响（规划书 §五十九 Sprint 4 验收）；Core 无 §四 禁词 |
| **Phase 2** | Sprint 5–15 | 11 | **P1 主导**（含 P0：S6 Provider Abstraction、S11 Handoff、S14 Recovery；含 P2：S5 Workflow Designer） | Designer + Provider / Registry / Runtime / Tool / Router + Handoff + Memory / Decision + Artifact / Validation + Recovery + Industry Pack Framework | 目标角色可正式接收结构化 Handoff；任何换模型、启动 Agent 或继续执行均由后续 Orchestrator 能力显式触发；Industry Pack 可装载 |
| **Phase 3** | Sprint 16–26 | 11 | **P2 主导**（含 P1：S16 DevCompany Pack、S18 CTO Workflow；含 P0：S24 Approval、S26 Crash Recovery E2E） | DevCompany 全角色链 CTO → Developer → Reviewer → QA → Documentation + Repository Runtime + Rework / Git Commit / Approval / Provider Failover / Crash Recovery | 全部 PASS 才自动 Commit（规划书 §五十九 Sprint 23）；修改中强制关闭软件后可恢复继续（规划书 §五十九 Sprint 26） |
| **Phase 4** | Sprint 27–30 | 4 | **P3 主导**（含 P2：S29 Desktop UI） | Workflow Metrics · Optimization Proposal · Desktop UI · MVP Hardening | 真实项目完整验证通过（规划书 §五十九 Sprint 30）；**新增 Mock ContentCompany Pack，若仅新增 Pack 即可落地则判定 Core 抽象成功**（规划书 §六十一） |

**P4 条目归属**：规划书 §五十八 的 P4（其他行业 Pack · Cloud · Marketplace · Team）不占用 Sprint 0–30 —— 规划书 §五十三「MVP 明确不做」已排除；第二行业按 §六十二「Core 验证后」启动。

## P0 至 P4 优先级映射

| 优先级 | 规划书 §五十八 条目（原文） | 映射到的 Sprint |
|---|---|---|
| **P0** | Core · Workflow Lifecycle · Versioning · State · Persistence · Handoff · Recovery · Provider Abstraction · Security · Approval | S1、S2、S3、S4、S6、S11、S14、S24、S26（Security 为横切项，贯穿 S0–S30） |
| **P1** | Model Registry · Router · Agent Runtime · Tool Registry · Validation · Risk · Memory · Decision · Artifact · DevCompany Pack | S7、S8、S9、S10、S12、S13、S15、S16、S18 |
| **P2** | Developer · Reviewer · QA · Git · Rework · Provider Failover · Desktop Workflow UI | S5、S17、S19、S20、S21、S22、S23、S25、S29 |
| **P3** | Metrics · Worktree · Parallel Agents · Workflow Optimization | S27、S28（Worktree / Parallel Agents 落在 S30 硬化清单） |
| **P4** | 其他 Industry Packs · Cloud · Marketplace · Team | 不排入 Sprint 0–30（§五十三 排除；§六十二 待 Core 验证后启动第二行业） |

> **优先级冻结（用户 STEP 3C 裁定）**：上表为唯一口径，与 `AGENTS.md` §2 及
> `docs/V1_1_RECONCILIATION.md`「冻结口径 C」逐字一致；`.planning/CANONICAL_SPEC.md` §5 的
> P1–P4 编号（把 Router / Agent Runtime 记为 P2）已作废。规划书 §五十八 的 P2 原文另含
> `Workflow Library UI`，归入 Desktop Workflow UI 一组（随 S29 落地），不单列。

### Sprint 级优先级一览

| Sprint | 名称 | 优先级 | Phase | 依据（规划书 §五十八） |
|---|---|---|---|---|
| 0 | Foundation | P0 | 0 | 底座，P0 全部条目的前置 |
| 1 | Core Domain | P0 | 1 | CompanyOS Core · Agent / Model 解耦 |
| 2 | Workflow Engine | P0 | 1 | State Machine |
| 3 | Persistence | P0 | 1 | Persistence |
| 4 | Workflow Lifecycle | P0 | 1 | Workflow Lifecycle · Workflow Versioning |
| 5 | Workflow Designer | P2 | 2 | Desktop Workflow UI |
| 6 | Provider Layer | P0 | 2 | Provider Abstraction |
| 7 | Model Registry | P1 | 2 | Model Registry |
| 8 | Agent Runtime | P1 | 2 | Agent Runtime |
| 9 | Tool Registry | P1 | 2 | Tool Registry |
| 10 | Router | P1 | 2 | Router |
| 11 | Handoff | P0 | 2 | Handoff |
| 12 | Memory + Decision | P1 | 2 | Memory · Decision |
| 13 | Artifact + Validation | P1 | 2 | Artifact · Validation（Risk 同属 P1，随本 Sprint 落地） |
| 14 | Recovery | P0 | 2 | Recovery |
| 15 | Industry Pack Framework | P1 | 2 | DevCompany Pack 的前置框架 |
| 16 | DevCompany Pack | P1 | 3 | DevCompany Pack |
| 17 | Repository Runtime | P2 | 3 | Git |
| 18 | CTO Workflow | P1 | 3 | DevCompany Pack（Chief / CTO 流程部分） |
| 19 | Developer | P2 | 3 | Developer |
| 20 | Reviewer | P2 | 3 | Reviewer |
| 21 | QA | P2 | 3 | QA |
| 22 | Rework Loop | P2 | 3 | Rework |
| 23 | Git Commit | P2 | 3 | Git |
| 24 | Approval | P0 | 3 | Approval |
| 25 | Provider Failover | P2 | 3 | Provider Failover |
| 26 | Crash Recovery E2E | P0 | 3 | Recovery |
| 27 | Workflow Metrics | P3 | 4 | Workflow Metrics |
| 28 | Workflow Optimization Proposal | P3 | 4 | Workflow 自动优化建议 |
| 29 | Desktop UI | P2 | 4 | Desktop Workflow UI · Workflow Library UI |
| 30 | MVP Hardening | P0 | 4 | 收敛验收：P0–P3 全部条目的回归确认 |

**升级 / 降级规则**：P2 条目若阻塞 P0 验收（如 Git Commit 阻塞 Recovery 的事实链），就地升为 P0 处理，不推迟；P4 条目若要求改动 Core，一律拒绝并改为 Pack 方案（规划书 §六十八）。

## 执行纪律（规划书 §六十六）

> **当前没有 active sprint。Sprint 13 已关闭；下一 Sprint 为 Sprint 14（Recovery），未经用户批准不得开工；禁止直接连续做到 Sprint 30。**

| # | 纪律 | 出处 |
|---|---|---|
| D1 | 本路线图是**规划**而非**授权**：任何时刻只有当前 Sprint 可执行，其余 30 个一律不得动手。 | §六十六 STEP 6 |
| D2 | 开工前先建文档：PRODUCT_VISION · PROJECT_CONSTITUTION · ARCHITECTURE · CORE_BOUNDARIES · MVP_SCOPE · STATE_MACHINE · WORKFLOW_LIFECYCLE · WORKFLOW_VERSIONING · WORKFLOW_METRICS · HANDOFF_PROTOCOL · MEMORY_ARCHITECTURE · DECISION_SYSTEM · VALIDATION_SYSTEM · SECURITY_MODEL · OPEN_SOURCE_RESEARCH · EXECUTION_ROADMAP（缺项见对账文档「新增任务」）。 | §六十六 STEP 1 |
| D3 | 每次开工先查 Core 是否被业务词污染：Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce —— 它们属于 Pack。 | §六十六 STEP 2 |
| D4 | Sprint 0 的验收命令是 `pnpm check`，**Exit Code 必须 0**。 | §六十六 STEP 7 |
| D5 | Sprint 0 结束：Git Commit + 更新 PROJECT_HANDOFF.md，然后**停止**并向用户汇报（架构结果 / Core 边界结果 / Workflow Lifecycle 结果 / 开源研究 / Sprint 0 结果 / Tests / Commit Hash / Known Risks / 建议的 Sprint 1），等待下一步指令。 | §六十六 STEP 8–9 |
| D6 | 每个 Sprint 节奏：Plan → Implement → Test → Independent Review → Commit → Update Handoff。 | §六十七 |
| D7 | 每个 Workflow 修改节奏：Proposal → Draft → Test → Review → Publish New Version；**禁止直接修改生产 Template**。 | §六十七 |
| D8 | 加功能前问两句：是否在加强 Workflow / SOP / Handoff / Validation / Memory / Routing / Risk / Recovery / Workflow Evolution，还是只加了一个模型按钮；这个能力以后 ContentCompany、EcommerceCompany 是否也能用。只有 DevCompany 能用的，放进 DevCompany Pack，不污染 Core。 | §六十八 |

## 全局 Sprint Definition of Done

| # | 条目 | 验证方式 |
|---|---|---|
| G1 | 该 Sprint 的 Acceptance Criteria 全部可复现 | 逐条重跑该 Sprint 的 Tests |
| G2 | `pnpm check` Exit Code 0（Sprint 0 之后沿用为回归门槛） | 命令退出码 |
| G3 | `packages/core/src/**` 无 §四 禁词（Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce） | 边界检查脚本 |
| G4 | 未越界实现后续 Sprint 的功能（Sprint 0 尤其禁止 Model Router / Agent Runtime / DevCompany / Coding Agent / Workflow Designer / 多模型调度） | 仓库树审计 |
| G5 | 文档与 PROJECT_HANDOFF.md 已更新 | 人工复核 |
| G6 | 结束时打 tag `sprint-N`，且文档中不写真实 commit hash | tag 存在性 |
| G7 | 事实来自真实工具输出（Exit Code / 测试结果 / Diff），不来自 Agent 自述（规划书 §二十一） | 真实输出留档 |

## Sprint 0：Foundation

- **Phase**：Phase 0 ｜ **优先级**：P0 ｜ **依赖**：无 ｜ **来源**：规划书 §五十九 Sprint 0
- **目标**：立起可构建、可测试、CI 通过的工程底座；不接任何真实 AI，不实现任何业务能力。
- **Task**
  - T0.1 建立 pnpm Monorepo（workspace 声明 `apps/*`、`packages/*`）
  - T0.2 TypeScript strict + 项目引用 + ESM 基线
  - T0.3 Electron 主进程与 preload 骨架（`contextIsolation` 开、`nodeIntegration` 关）
  - T0.4 React 渲染进程骨架（可启动、可挂载）
  - T0.5 SQLite 接入（本地单文件库）
  - T0.6 Migration 机制（编号迁移 + 重复执行为 no-op）
  - T0.7 Logging（结构化日志 + 关联 id）
  - T0.8 Testing（单元测试 + 架构边界测试）
  - T0.9 CI（安装 + `pnpm check` 流水线）
  - T0.10 `AGENTS.md`（架构法、禁词、端口命名、DoD）
  - T0.11 `PROJECT_HANDOFF.md`（状态、已验证命令、环境事实、下一步入口、风险）
  - T0.12 仓库卫生（忽略构建产物与本地库文件、编辑器与运行时版本约束）
- **Acceptance Criteria**
  - AC0.1 `pnpm check` Exit Code 0（规划书 §六十六 STEP 7）
  - AC0.2 Monorepo 可解析 / 可安装 / 可构建；Electron 窗口可打开并渲染页面；SQLite 可打开且迁移可应用
  - AC0.3 无被禁范围代码：Model Router / Agent Runtime / DevCompany / Coding Agent / Workflow Designer / 多模型调度（规划书 §五十三 MVP 不做项不计入 Sprint 0）
  - AC0.4 `AGENTS.md` 与 `PROJECT_HANDOFF.md` 已提交
- **Tests**
  - 工作区完整性检查：每个 package 目录均可解析
  - 迁移测试：首次应用成功、二次应用 no-op、校验和不匹配时拒绝打开
  - 日志测试：敏感字段被掩码、关联 id 传递到子 logger；边界测试：Core 出现禁词即构建失败
- **Git Checkpoint**：`sprint-0`

## Sprint 1：Core Domain

- **Phase**：Phase 1 ｜ **优先级**：P0 ｜ **依赖**：`sprint-0` ｜ **来源**：规划书 §五十九 Sprint 1
- **目标**：把「规划书 §四 Core 词表」落成领域模型；**不接真实 AI**。
- **Task**
  - T1.1 实现 Company 与 Industry Pack 实体（Pack 注册与版本，仅契约层）
  - T1.2 实现 Workflow 实体
  - T1.3 实现 Workflow Template 实体
  - T1.4 实现 Workflow Version 实体
  - T1.5 实现 Workflow Run 实体
  - T1.6 实现 Stage 与 Task 实体
  - T1.7 实现 Role 与 Agent 实体（岗位与模型解耦，规划书 §二十三）
  - T1.8 实现 Artifact 实体（Core 只认识 Artifact，规划书 §三十一）
  - T1.9 实现 Validation 实体（Validator 定义 + Validation Result）
  - T1.10 实现 Approval 实体（审批请求与结果）
  - T1.11 实现 Event 实体与事件信封（规划书 §四十三 事件类型可枚举）
- **Acceptance Criteria**
  - AC1.1 规划书 §五十九 Sprint 1 列出的 14 个概念（Company / Pack / Workflow / Workflow Template / Workflow Version / Workflow Run / Stage / Task / Role / Agent / Artifact / Validation / Approval / Event）全部有类型定义、不变量与校验
  - AC1.2 Core 中无 §四 禁词及其派生标识符
  - AC1.3 Role 与 Model 完全解耦：不存在 `Developer = DeepSeek` 这类绑定（规划书 §二十三）；本 Sprint 零网络调用、零供应商接入
- **Tests**
  - `packages/core/tests/core-domain.test.ts`：14 个概念各自可构造、可校验、非法输入被拒
  - `packages/core/tests/role-model-decoupling.test.ts`：Role 定义中不含具体模型名
  - 边界测试：Core 出现禁词即失败
- **Git Checkpoint**：`sprint-1`
- **交付结果（已完成，提交 `e13379c`，tag `sprint-1.0.0`）**
  - **Task 覆盖**：T1.1 Company + Pack 安装（`domain/company.ts`、`domain/pack.ts`）｜T1.2 Workflow 容器
    （`domain/workflow.ts`）｜T1.3 Workflow Template（复用 L2 `lifecycle/template.ts`，与 Workflow 接线）｜
    T1.4 Workflow Version（复用 L2 `lifecycle/version.ts`）｜T1.5 Workflow Run（`domain/workflow-run.ts`）｜
    T1.6 Stage / Task（`domain/stage.ts`、`domain/task.ts`）｜T1.7 Role / Agent（`domain/role.ts`、
    `domain/agent.ts`）｜T1.8 Artifact（`domain/artifact.ts`）｜T1.9 Validation（`domain/validation.ts`）｜
    T1.10 Approval（`domain/approval.ts`）｜T1.11 Event 目录与信封（`domain/event.ts`）
  - **AC1.1**：14 个概念全部有类型定义 + 不变量 + 校验 + 测试（含 Role/Agent 的解耦断言）
  - **AC1.2**：边界门扫描 42 个 Core 源文件通过；`packages/core/src/domain` 无任何禁词
  - **AC1.3**：Role 无 model/provider 字段；Agent 拒绝一切具体 provider/model 绑定（仅接受 `logical.*`）；
    本 Sprint 零网络调用、零供应商接入
  - **新增基础类型**：`kernel/brand.ts`（品牌化类型）、`kernel/identifiers.ts`（17 个聚合 id 类型 +
    `asId` 转换缝）、`kernel/errors.ts` 新增 9 个错误码与 `domainError()` 辅助
  - **端口冻结**：新增 `ports/workflow-engine.ts`、`ports/event-store.ts`，共 11 个端口（ADR-0002）
  - **状态分层落地**：L1 `domain/run-state.ts`（17 态）、L3 `domain/stage.ts` / `domain/task.ts`；
    L2 保持 `lifecycle/machine.ts` 不变（ADR-0003）
  - **测试**：新增 `packages/core/tests/domain/`（10 个测试文件）+ `docs/tests/workspace-governance.test.ts`；
    全仓 37 个测试文件 / 302 个测试全部通过，无 `skip` / `only` / 删除测试
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS
  - **Git Checkpoint**：`sprint-1`（实际 tag `sprint-1.0.0`，提交 `e13379c`；完整哈希见 `PROJECT_HANDOFF.md` 的 Commit 段）

## Sprint 2：Workflow Engine

- **Phase**：Phase 1 ｜ **优先级**：P0（State Machine）｜ **依赖**：`sprint-1` ｜ **来源**：规划书 §五十九 Sprint 2
- **目标**：让 Workflow 用 Fake Agent 真正跑起来，把流程控制能力做全。
- **Task**
  - T2.1 实现 Transition（Stage 之间的流转）
  - T2.2 实现 Retry（失败重试策略）
  - T2.3 实现 Pause / Resume（暂停并保留状态、从暂停点继续）
  - T2.4 实现 Loop（循环）与 Branch（分支）
  - T2.5 实现 Failure（失败态与失败传播）
  - T2.6 实现 Approval 介入点（执行前挂起等待）
  - T2.7 实现 Fake Agent（确定性假执行者，供引擎测试）
- **Acceptance Criteria**
  - AC2.1 含 Stage / Task / Transition 的 Workflow 可被完整驱动到结束
  - AC2.2 八项流程控制能力各有独立可复现用例；Fake Agent 使测试完全离线且确定（同输入同输出）
  - AC2.3 非法流转被显式拒绝，不产生部分状态
- **Tests**
  - `packages/core/tests/workflow-engine.test.ts`：八项流程控制能力逐一覆盖
  - `packages/core/tests/fake-agent.test.ts`：Fake Agent 输出确定性
  - `packages/core/tests/illegal-transition.test.ts`：非法流转拒绝且状态不变
- **Git Checkpoint**：`sprint-2`
- **交付结果（已完成，提交 `b078eb0`，tag `sprint-2.0.0`）**
  - **Task 覆盖（用户 17 项要求）**：① `WorkflowEnginePort` 外环实现（`packages/engine`）｜
    ② Command → Engine → Event 边界（Core `domain/commands.ts` + 引擎 `command-router.ts`，30:30 满射）｜
    ③ 正常推进（确定性 driver）｜④ Retry（任务级，恰好 `maxAttempts`）｜⑤ Pause ｜⑥ Resume（返回
    `resumePoint`）｜⑦ Failure（`FAILED` + `reason`）｜⑧ Approval（请求/批准/拒绝 + 授权 + 职责分离）｜
    ⑨ Rework（预算内回到执行、超预算 `PAUSED`）｜⑩ Branch 最小确定性语义（Core `domain/branch.ts`，
    首个匹配胜出 + 默认分支）｜⑪ 每次合法转移产生事件（Run 级 + Task 级 + Approval 级）｜
    ⑫ 非法转移拒绝且 Run 逐字节不变｜⑬ 幂等（`commandId` + 内容指纹 + 有界账本）｜⑭ `resumePoint`
    定义与测试｜⑮ `WorkflowRun.revision` 防 stale command（`CONFLICT/stale_revision`）｜
    ⑯ 并发命令冲突（同 Run FIFO 串行化 + 乐观并发）｜⑰ 独立 Domain/Engine 测试
  - **新增包**：`@companyos/engine`（运行时依赖**仅** `@companyos/core`；边界由 `boundary.test.ts` 强制）
  - **Core 增量**：`domain/commands.ts`（命令契约）、`domain/branch.ts`（确定性分支）、
    `domain/event.ts` 的 `CORE_EVENT_EMITTERS`（每个事件唯一发射方）、`WorkflowRun.revision` 与
    `expectedRevision` 守卫
  - **测试矩阵 A–L**：`packages/engine/tests/` 13 个文件 + Core 4 个新测试文件
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜55 个测试文件 / **394** 个测试全部通过｜
    `pnpm test:scripts` 22/22｜边界门 PASS（44 个 Core 源文件 + 8 个 contracts）
  - **独立评审**：首轮 **PASS WITH CONDITIONS**（1 HIGH 孤儿审批 + 4 MEDIUM），全部修复并补回归测试
  - **实际 tag**：`sprint-2.0.0`（完整哈希见 `PROJECT_HANDOFF.md` 的 Commit 段）

## Sprint 3：Persistence

- **Phase**：Phase 1 ｜ **优先级**：P0 ｜ **依赖**：`sprint-2` ｜ **来源**：规划书 §五十九 Sprint 3
- **目标**：把 Sprint 1–2 产生的全部状态落到本地数据库；关掉软件再打开数据仍在。
- **Task**
  - T3.1 持久化 Workflow / Template / Version
  - T3.2 持久化 Run 与 Task
  - T3.3 持久化 Event
  - T3.4 持久化 Handoff
  - T3.5 持久化 Approval
  - T3.6 建立按规划书 §五十六 命名对齐的核心表结构（表清单见对账文档）
  - T3.7 状态写入与事件追加同事务（不允许半写）
- **Acceptance Criteria**
  - AC3.1 关闭软件再打开，八类数据全部存在且一致（规划书 §五十九 Sprint 3 验收）
  - AC3.2 迁移可重放且幂等；表命名与规划书 §五十六 的映射关系被记录（以 `workflow_runs` 等规划书命名为准）
  - AC3.3 事务失败时状态与事件一并回滚
- **Tests**
  - `packages/persistence/tests/roundtrip.test.ts`：八类数据写 → 重启 → 读回一致
  - `packages/persistence/tests/transaction-atomicity.test.ts`：状态与事件同事务
  - `packages/persistence/tests/migration-idempotent.test.ts`：迁移重复执行为 no-op
- **Git Checkpoint**：`sprint-3`
- **交付结果（已完成，提交 `5f37c74`，tag `sprint-3.0.0`）**
  - **15 项要求**：① `@companyos/persistence` + `node:sqlite`｜② WorkflowRun / Task / Approval 持久化｜
    ③ `EventStorePort` 实现｜④ `command_ledger` 持久化｜⑤ `UnitOfWork`｜
    ⑥ Run 状态 + Event + ledger（含审批副作用与阶段执行）**同一事务**｜⑦ 失败整体 rollback｜
    ⑧ `global_position` 稳定顺序 + 按 Run 回放（`readByRun`）｜⑨ `resumePoint`/`reworkCount`/`maxRework`/
    `failureReason` 落库｜⑩ Approval 状态落库｜⑪ 跨重启 duplicate 仍幂等｜⑫ 跨重启 stale revision 仍拒绝｜
    ⑬ 重启后 Run 可继续｜⑭ 迁移 checksum（两条链）｜⑮ Core/Engine 边界未被破坏
  - **新增**：Core `ports/command-ledger.ts`（纯类型）+ `PERSISTENCE_FAILED` 错误码；
    persistence `src/durable/`（unit-of-work / 四个 SQLite store / command ledger / 组合根）；
    迁移 `migrations/engine/0001_engine_persistence.sql`（独立校验和链，core 链未改）
  - **测试**：仓库根 `tests/sprint3/` 6 个文件（A–L + 边界）；全仓 61 个测试文件 / **433** 个测试
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS
  - **独立评审**：首轮 **PASS WITH CONDITIONS**（1 HIGH：阶段执行无事务 + 3 MEDIUM），全部修复并补回归测试
  - **实际 tag**：`sprint-3.0.0`（完整哈希见 `PROJECT_HANDOFF.md` 的 Commit 段）

## Sprint 4：Workflow Lifecycle

- **Phase**：Phase 1 ｜ **优先级**：P0（Lifecycle · Versioning）｜ **依赖**：`sprint-3` ｜ **来源**：规划书 §五十九 Sprint 4（规划书 §五 提升为 P0 的核心模块）
- **目标**：Workflow 拥有完整生命周期，Published SOP 不可原地篡改。
- **Task**
  - T4.1 实现 Draft（设计态，Chief 可创建草稿）
  - T4.2 实现 Review（草稿评审）
  - T4.3 实现 Publish（草稿 → 模板态，产出 v1.0）
  - T4.4 实现 Version（v1.0 / v1.1 / v2.0 并存，规划书 §九）
  - T4.5 实现 Fork（从成熟模板派生变种，规划书 §七）
  - T4.6 实现 Deprecate（停止用于新建 Run，历史保留）
  - T4.7 实现 Archive（彻底归档，仅供查看 / 审计 / 历史分析）
  - T4.8 实现 Run Snapshot（Run 创建时固定 Template 快照，规划书 §十一）
  - T4.9 实现 Template Lock（阻止运行中的 Run 被模板变更影响）
  - T4.10 落地「禁止原地修改已发布 Template」的强制路径（规划书 §十）
- **Acceptance Criteria**
  - AC4.1 **Published Template 不能直接修改**（规划书 §五十九 Sprint 4 验收）；修改只能走 Change Proposal → Fork → 新 Draft → 测试 → Review → Publish 新版本
  - AC4.2 **旧 Run 不受新版本影响**：Template 升级后，正在执行的 Run 仍按原版本执行（规划书 §五十九 Sprint 4 验收）
  - AC4.3 Run Snapshot 含 Template ID / Version / Stage 定义 / Role 定义 / Validator / Risk 规则 / Tool 绑定 / Capability 需求 / Prompt 版本（规划书 §十一）；Deprecated 拒绝新 Run，Archive 只读
- **Tests**
  - `packages/core/tests/lifecycle.test.ts`：Draft/Review/Publish/Version/Fork/Deprecate/Archive 全路径
  - `packages/core/tests/published-immutable.test.ts`：原地修改被拒
  - `packages/core/tests/run-snapshot.test.ts`：模板升级不影响在跑 Run；`template-lock.test.ts`：锁定期间变更被拒
- **Git Checkpoint**：`sprint-4`
- **交付结果（已完成，提交 `dbbf2e4`，tag `sprint-4.0.0`）**
  - **17 项要求**：①②③④ 四张治理表 + `run_snapshots`｜⑤ Draft→Publish 生命周期｜⑥ 已发布禁止原地修改
    （服务层 + 存储层双拦）｜⑦ Change Proposal → Draft → Review → Publish｜⑧ 版本不可变｜
    ⑨ 每版本持久化 `content_hash`/`snapshot_hash`｜⑩ Run 创建绑定固定版本快照｜⑪ 模板升级不影响在跑 Run｜
    ⑫ Deprecated 禁止新 Run｜⑬ Archived 只读｜⑭ Template Lock 防并发双发布（数据库部分唯一索引）｜
    ⑮ 生命周期事件写入 EventStore（按 `global_position` 有序）｜⑯ 模板/版本/锁/提案状态持久化｜
    ⑰ 崩溃安全与重启恢复
  - **新增**：`packages/engine/src/lifecycle-service.ts`（外环编排，只 import Core）；
    persistence `sqlite-template-store.ts` / `sqlite-lifecycle-stores.ts`；
    迁移 `migrations/lifecycle/0001_workflow_lifecycle.sql`（第三条校验和链）；
    Core 加法式 `versionSnapshotHash` + 修正 `publishRevision` 未重算 `contentHash` 的缺陷
  - **测试**：`tests/sprint4/` 4 个文件（A–O + 边界 + 授权缝）；全仓 65 个测试文件 / **461** 个测试
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS
  - **独立评审**：首轮 **PASS WITH CONDITIONS**（5 MEDIUM：版本事件聚合标识错位、`snapshotOfRun` 类型说谎、
    评审门/Fork 映射未记录、授权缺口、Bible 与本实现口径冲突），全部修复并补回归测试（含授权缝测试）
  - **实际 tag**：`sprint-4.0.0`（完整哈希见 `PROJECT_HANDOFF.md` 的 Commit 段）

## Sprint 5：Workflow Designer

- **Phase**：Phase 2 ｜ **优先级**：P2（Desktop Workflow UI）｜ **依赖**：`sprint-4` ｜ **来源**：规划书 §五十九 Sprint 5、§四十九
- **目标**：做出最小可用的 Workflow Designer，让 Chief / 用户可视化造 SOP。
- **Task**
  - T5.1 创建 Draft（设计态入口）
  - T5.2 增加 Stage（可视化编排节点）
  - T5.3 绑定 Role（Stage 与岗位绑定）
  - T5.4 绑定 Validator（Stage 与质量校验绑定）
  - T5.5 配置 Transition（含 Branch / Loop 连线）
  - T5.6 Publish Template（从界面发布为模板）
  - T5.7 对齐规划书 §四十九 的可视化清单：Stage / Role / Task / Transition / Branch / Loop / Validator / Approval / Tool / Artifact
- **Acceptance Criteria**
  - AC5.1 全程可在 UI 完成：造 Draft → 加 Stage → 绑 Role/Validator → 配 Transition → Publish
  - AC5.2 非法图（悬空引用、非法流转）在保存前被拒绝；发布动作与 Sprint 4 的 Version 系统共用同一套数据
  - AC5.3 用户可查看 / 修改 / 批准 / 发布 / Fork（规划书 §四十九）
- **Tests**
  - `apps/renderer/tests/designer.test.ts`：Draft → Stage → Role → Validator → Transition → Publish 全链路
  - `apps/renderer/tests/designer-validation.test.ts`：非法图被拒
  - `apps/renderer/tests/designer-publish.test.ts`：界面发布产生的版本与领域模型一致
- **Git Checkpoint**：`sprint-5`
- **交付结果（已完成，tag `sprint-5.0.0` → `1caaba4`；主提交 `90ef618`）**
  - **范围**：最小 Workflow Library + Designer（可用、清晰、可测试，不做视觉打磨）
  - **新增**：Core `lifecycle/change-ops.ts`（9 个 op 的纯函数 `applyChangeOps`）与
    `lifecycle/graph-validation.ts`（10 类校验 + `assertPublishable`）；
    Desktop 应用层 `apps/desktop/src/workflows.ts`（单通道 + 20 个 operation + schema 校验）；
    Renderer `designer-model.ts`（纯投影）与 `designer.tsx`（Library + Designer）
  - **接线**：`channels.ts` 新增唯一 feature channel `companyos:workflow`（**契约变更**，用户 STEP 3 授权）、
    `preload.cjs` 只暴露 `workflowRequest`、`main.ts` 惰性打开 `chains: ['core','engine','lifecycle']`
  - **测试**：`packages/core/tests/lifecycle/*`（ChangeOp 确定性/非法拒绝/图校验）、
    `apps/desktop/tests/workflows.test.ts`（A/B/F/G/H/I/J/K/L/M/N/Q/R）、
    `tests/sprint5/designer-boundary.test.ts`（O/P + 单通道 + 唯一入口）
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS
  - **独立评审**：见 `PROJECT_HANDOFF.md` 的评审记录

## Sprint 6：Provider Layer

- **Phase**：Phase 2 ｜ **优先级**：P0（Provider Abstraction）｜ **依赖**：`sprint-5` ｜ **来源**：规划书 §五十九 Sprint 6、§四十、§四十一
- **目标**：建立统一模型供应商接口，接第一批 Provider。
- **Task**
  - T6.1 定义统一 Provider 接口（healthCheck / listModels / run / stream，规划书 §四十）
  - T6.2 接入 OpenAI
  - T6.3 接入 Anthropic
  - T6.4 接入 DeepSeek
  - T6.5 接入 OpenAI-Compatible（覆盖兼容网关）
  - T6.6 统一错误与超时语义（为 Sprint 14 Recovery、Sprint 25 Failover 预留契约）
- **Acceptance Criteria**
  - AC6.1 四个 Provider 走同一接口，调用方不感知厂商差异；可健康检查、可列模型、可同步调用、可流式返回
  - AC6.2 未配置密钥时不崩溃，返回明确错误类型
  - AC6.3 模型只是可替换劳动力，替换 Provider 不需要改 Core（规划书 §二 原则 2）
- **Tests**
  - `packages/providers/tests/provider-contract.test.ts`：四个 Provider 跑同一套契约用例（离线桩）
  - `packages/providers/tests/health.test.ts`：健康状态与失败态
  - `packages/providers/tests/stream.test.ts`：流式事件顺序与终止
- **Git Checkpoint**：`sprint-6`
- **交付结果（已完成，tag `sprint-6.0.0` → `6bb777b`；评审修复 `583b998`）**
  - **交付范围（按用户 Sprint 6 约束）**：`ModelProviderPort` 契约 + `ProviderRegistry`（显式 id 绑定，
    **不是 Router**）+ `ModelInfo`/能力/上下文/定价 + HealthCheck/Invoke/Stream/结构化输出/工具调用声明 +
    12 种 Provider 错误归一（限流/配额/超时/上下文映射）+ `SecretRef` 指针边界 + MockProvider +
    最小 `Role → Authority` + **单 durable 句柄合并** + 第四条校验和迁移链（provider）。
  - **零真实适配器**：本轮明确禁止接入任何厂商；`T6.2–T6.5`（接入具体厂商与 OpenAI-兼容方言）与
    `AC6.1`（四个 Provider 走同一接口）**延后**，需先立 ADR（厂商 Adapter 只能在外环）+ 取得用户批准。
  - **测试**：`tests/sprint6/{providers,authorization,boundary}.test.ts`（A–Q + 授权 + P）；
    全仓 72 个测试文件 / **572** 个测试。
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS（出厂源码零厂商名）。

## Sprint 7：Model Registry

- **Phase**：Phase 2 ｜ **优先级**：P1 ｜ **依赖**：`sprint-6` ｜ **来源**：规划书 §五十九 Sprint 7、§二十四、§二十五
- **目标**：登记每个模型的能力档案与经营指标，为 Router 提供事实底表。
- **Task**
  - T7.1 登记 Capability（规划书 §二十五 的 coding / reasoning / review / writing / research / chinese / longContext / toolUse / speed / costEfficiency）
  - T7.2 登记 Cost
  - T7.3 登记 Health
  - T7.4 登记 Quota
  - T7.5 登记 Availability
  - T7.6 维护规划书 §二十四 其余字段：Provider / Model Name / Context Window / Latency / Success Rate / Review Pass Rate / Rework Rate / Failure Rate
  - T7.7 MVP 采用人工配置能力档案，并预留「依据真实任务自动更新」的入口（规划书 §二十五）
- **Acceptance Criteria**
  - AC7.1 每个模型拥有完整档案，字段与规划书 §二十四 一一对应
  - AC7.2 Capability 为 0–9 打分制，MVP 由人工配置（规划书 §二十五）
  - AC7.3 档案是数据而非代码：模型换掉后任务不重来（规划书 §二 原则 9）；无真实统计数据时留空，不造数
- **Tests**
  - `packages/model-registry/tests/registry.test.ts`：档案字段完整性与取值合法性
  - `packages/model-registry/tests/capability-profile.test.ts`：能力档案读写与变更留痕
  - `packages/model-registry/tests/registry-empty-stats.test.ts`：无数据时字段为空而非编造值
- **Git Checkpoint**：`sprint-7`
- **交付结果（已完成，tag `sprint-7.0.0`）**
  - **Sprint 6 三项欠账闭环**：① `ProviderRegistry` / `SecretVault` / `ModelRegistry` 注入 `authorize`，
    在 `provider.register/invoke/read`、`secret.read/write`、`model.register/write` 强制判定；
    ② 上下文估算按字符类别（ASCII/CJK/emoji/code）并保守取整，适配器须复检；
    ③ 新增 `provider.registered/health_checked/invoked/failed` 与 `model.registered/enabled/disabled/alias_bound` 审计事件。
  - **Model Registry**：`ModelRecord`（稳定 modelKey、能力档案、上下文、定价、启停、可用性）、
    Provider Binding、`LogicalAlias`（一别名一模型，冲突即拒）、Availability/Health 派生、
    元数据持久化与重启保留、最小 Registry UI（只经 `models.*` IPC）。
  - **不是 Router**：入口必须点名（key 或别名），源码与 DDL 无 score/rank/priority/fallback（测试断言）。
  - **测试**：`tests/sprint7/{model-registry,registry-boundary}.test.ts`（A–Q）；全仓 74 个测试文件 / **597** 个测试。
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS（出厂源码零厂商名）。

## Sprint 8：Agent Runtime

- **Phase**：Phase 2 ｜ **优先级**：P1 ｜ **依赖**：`sprint-7` ｜ **来源**：规划书 §五十九 Sprint 8
- **目标**：让岗位真正干活：Role + Prompt + Model + Tool + 结构化输出 + Run。
- **Task**
  - T8.1 装载 Role（从岗位定义构造执行者）
  - T8.2 装载 Prompt（版本化提示词）
  - T8.3 绑定 Model（经 Router 注入，不在 Runtime 内硬编码）
  - T8.4 调用 Tool（经 Tool Registry 解析）
  - T8.5 产出 Structured Output（结构化输出 + schema 校验）
  - T8.6 驱动 Run（Agent 在 Run 内的执行循环）
  - T8.7 记录真实事实：Tool 结果 / Artifact / Validation 优先于 Agent 自述（规划书 §二 原则 7）
  - T8.8 执行只读 Run Snapshot，不读在线模板状态（规划书 §十一）
- **Acceptance Criteria**
  - AC8.1 一个 Stage 可由指定 Role 在指定 Model 上完成并产出结构化结果
  - AC8.2 结构化输出不符合契约时判失败，而不是被接受
  - AC8.3 Agent 自述不构成事实；PASS 需结合 Validation / Artifact / Tool Result（规划书 §二 原则 7）；Runtime 不硬编码任何供应商或模型名
- **Tests**
  - `packages/agent-runtime/tests/runtime.test.ts`：Role + Prompt + Model + Tool + Output + Run 全链路
  - `packages/agent-runtime/tests/structured-output.test.ts`：契约不符即失败
  - `packages/agent-runtime/tests/snapshot-only.test.ts`：执行期不读取在线模板
- **Git Checkpoint**：`sprint-8`
- **交付结果（已完成，tag `sprint-8.0.0`）**
  - **Agent Execution Runtime**：`prepare/run/execute/cancel/recoverInterrupted/get/list`，
    输入必须带明确 `modelKey`（无则 `MODEL_SELECTION_REQUIRED`）；执行链
    Task+Role+Binding → AgentContext → 确定性 PromptAssembler → ProviderRegistry.invoke → InvocationResult
    → AgentExecution（COMPLETED/FAILED）+ resultRef/artifactRefs/usage/latency/trace。
  - **独立执行状态机**：`CREATED/READY/RUNNING/WAITING_EXTERNAL/COMPLETED/FAILED/CANCELLED/INTERRUPTED`，
    与 L1/L2/L3 严格分离；崩溃恢复标 `INTERRUPTED`（绝不 COMPLETED、绝不重放）。
  - **审计与错误**：7 个 `agent.*` 事件；13 种执行错误 kind → Core 码映射 + `retryable` 元数据；
    Provider 错误一律不换模型；错误消息落库前脱敏。
  - **持久化**：第七条校验和保护链 `migrations/agent/0001_agent_runtime.sql`
    （`agent_executions` + `agent_execution_artifacts`，DDL 中无 secret/token/credential 列）。
  - **测试**：`tests/sprint8/{agent-runtime,runtime-boundary}.test.ts`（A–AB）；全仓 78 个测试文件 / **664** 个测试。
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS（出厂源码零厂商名）。

## Sprint 9：Tool Registry

- **Phase**：Phase 2 ｜ **优先级**：P1 ｜ **依赖**：`sprint-8` ｜ **来源**：规划书 §五十九 Sprint 9、§三十八、§三十九
- **目标**：工具可注册、有权限、有风险等级、可执行、可审计。
- **Task**
  - T9.1 实现 Registration（Tool Name / Capability / Permission / Risk / Input Schema / Output Schema / Audit Policy，规划书 §三十八）
  - T9.2 实现 Permission（按 Role 授予不同权限，规划书 §三十九）
  - T9.3 实现 Risk（工具风险等级，接入 Sprint 24 审批）
  - T9.4 实现 Execution（统一调用入口与结果归一化）
  - T9.5 实现 Audit（回答规划书 §四十四 的九问）
  - T9.6 登记 DevCompany 工具类别：Filesystem / Search / Terminal / Git / Test Runner / Build / Lint / Database / Browser（规划书 §三十八）
  - T9.7 高危默认拒绝：Reviewer 默认只有读 / 搜索 / 测试 / Git Diff（规划书 §三十九）
- **Acceptance Criteria**
  - AC9.1 工具契约七字段完整且可被 schema 校验；未授权调用被拒并留痕
  - AC9.2 Reviewer 默认无权大量改代码、删项目、生产部署、改 Secrets（规划书 §三十九）
  - AC9.3 每次调用都能回答：谁做的 / 什么时候 / 用什么模型 / 用了什么 Workflow Version / 调用什么工具 / 修改什么 / 为什么修改 / 花多少钱 / 最终结果是什么（规划书 §四十四）
- **Tests**
  - `packages/tool-registry/tests/registry.test.ts`：注册字段完整性
  - `packages/tool-registry/tests/permission.test.ts`：越权调用被拒
  - `packages/tool-registry/tests/audit.test.ts`：审计九问可回答
- **Git Checkpoint**：`sprint-9`
- **交付结果（已完成，tag `sprint-9.0.0`）**
  - **Sprint 8 三项遗留闭环**：① `agent.read` 接入 `agent.get/agent.list`；② `run()` 执行前**重新验证**
    （enabled / availability / provider / policy，同一模型，绝不换模型）；③ `recoverInterrupted()` 改为**分页扫描**。
  - **Tool Registry**：`ToolRecord`（capabilities / input+output schema / riskLevel / requiredAuthorities /
    timeoutMs / idempotencyMode / auditPolicy / providerKind+adapterRef）+ `ToolPort`（describe/invoke，可选
    health/cancel）+ 注册/启停/读取 + `tool.*` 五个 authority 全执行点检查 + 风险分级
    （LOW/MEDIUM/HIGH/CRITICAL；HIGH 必须审批、CRITICAL 禁止自批）+ 双向 schema 校验 +
    三种幂等模式（DB 部分唯一索引兜底）+ 八类 `tool.*` 审计事件 + 第八条校验和迁移链。
  - **一次受控工具轮**：`runtime.runToolCall` = Model → Tool Call → Tool Result → Runtime，**恰一轮**；
    `prompt.toolIds` 把注册表里的真实 ToolDescriptor 声明给模型（仍不替模型选工具）。
  - **MockTools**：Echo / ReadOnly / Failing / HighRisk / Critical / Slow，全部确定性、零 IO、零破坏性。
  - **测试**：`tests/sprint9/{tool-registry,tool-boundary}.test.ts`（A–AB）；全仓 81 个测试文件 / **704** 个测试。
  - **验收**：`pnpm check` Exit Code 0（5× PASS）｜`pnpm test:scripts` 22/22｜边界门 PASS（零厂商名、零真实工具名）。
- **Sprint 9.1 交付结果（已完成，tag `sprint-9.1.0`；评审修复 tag `sprint-9.1.1`）**
  - **Tool Invocation Recovery**：`STARTED → INTERRUPTED`（审计 `tool.invocation_interrupted` + `previousStatus`）；
    `WAITING_APPROVAL` 重启后**原样保留**（不自动批准/执行）；**NON-IDEMPOTENT 永不自动重试**（连 retryable 列表都不进）；
    幂等工具可由**显式** `retryInvocation()` 重试（新 attempt 行 + `#retry` 派生键）。
  - **幂等索引化**：按 `idempotency_key` 走唯一索引精确查询；**未接线即拒绝**（不再回退到 500 行扫描）；
    UNIQUE 冲突翻译为 `CONFLICT`（`kind: IDEMPOTENT_REPLAY`）；命中重放发射 `tool.invocation_replayed`
    并返回 `replayed/originalInvocationId/originalStatus`（**FAILED 仍是 FAILED**）。
  - **列表分页**：`list({limit, cursor})` → `{items, nextCursor}`（默认 50 / 上限 200 / 畸形游标 `INVALID_ARGUMENT`）；
    `descriptors()` 也改为内部游标分页，声明工具不再漏项。
  - **Descriptor 进 PromptPlan**：真实 `toolId/name/description/parameters/capabilities/riskLevel`
    （无 adapterRef / 权限 / secret），按 toolId 排序 ⇒ 相同 descriptors 相同 `promptHash`（模板 `agent-prompt/v2`）。
  - **HIGH 自批规则显式化**：ADR-0013 §15 记录为有意设计 + 测试锁定（HIGH 可自批 / CRITICAL 禁止）。
  - **测试**：`tests/sprint9-1/tool-hardening.test.ts`（A–O，15 条）；全仓 82 个测试文件 / **721** 个测试。
- **Sprint 9.1.2 交付结果（已完成，tag `sprint-9.1.2`）**
  - **连续 Retry 链**：每次显式 `retryInvocation()` 都是新 attempt（新 id、parent、稳定 root、单调 `attemptNumber`），
    幂等键 `<base>#retry-<n>`（占用继续 +1，50 次用尽 → `CONFLICT`），第 N 次永不误命中第 N-1 次 replay；
    NON-IDEMPOTENT 仍禁止。
  - **Descriptor 快照**：深拷贝 + 递归 freeze，外部 mutation 不改变已产出的 plan/hash。
  - **分页稳定排序**：`ORDER BY created_at DESC, id DESC` + 索引；1000 条同时间戳跨页不重复/不丢失/不漂移。
  - **测试**：`tests/sprint9-1-2/nit-hardening.test.ts`（7 条）；全仓 83 个测试文件 / **728** 个测试。
- **Sprint 10A 交付结果（已完成，tag `sprint-10a.0.0`）— 只冻结设计，不实现**
  - **ADR-0014**：职责边界（改 Policy / 绕 blocked / 覆盖人工选择 / 调 Provider / 执行 Agent 全部禁止）、
    三模式语义、冻结优先级（Router Recommendation 不得覆盖前五层）、`blockedModels` 硬阻断（显式选择也不能越过）、
    12 个场景问答（A–L）。
  - **候选流水线冻结**（14 段）与 **Hard Filter / Ranking 结构分离**：被淘汰者不得靠高分复活（有断言）。
  - **契约类型**：`RouterRequest` / `ModelRecommendation` / `CandidateEvaluation` / `RejectedCandidate` /
    `RejectionSummary` / `RouterProvenance` / `FallbackDecision` / `HumanOverride` / `OverrideRecord` /
    `ModelDiversityConstraint` / `RouterRiskConstraint` / `ModelRouterPort`（**无实现**）。
  - **纯规则**：`applyHardFilters`、`compareTieBreak`（五键全序）、`decideFallback`、`routerUnavailableOutcome`、
    `noCandidateOutcome`、`manualOutcome`、`applyHumanOverride`、`sampleConfidence`、`effectiveBenchmarkWeight`
    （上限 0.15）、`checkDiversity`；ReasonCode 目录 23 + 14 个（闭集）。
  - **审计事件类型（未发射）**：`router.*` 六个；**明确不实现**：Router 端口无实现、组合根未装配、
    Runtime/Tool Registry 不依赖；AUTO 仍是 `MODEL_SELECTION_REQUIRED` / `ROUTER_NOT_AVAILABLE`。
  - **测试**：`tests/sprint10a/router-contract.test.ts`（A–S，19 条）；全仓 84 个测试文件 / **747** 个测试。
- **Sprint 10A.0.2 / 10A.0.3 交付结果（已完成，tag `sprint-10a.0.2` / `sprint-10a.0.3`）— 契约硬化**
  - **10A.0.2**：MANUAL 强制门 `assertRouterRequestAllowed`（HIGH-1）· 防篡改门接入 `applyHardFilters`（Result + 入口校验）·
    唯一 ranking 目录（删 `RANKING_SIGNALS`）· latency 诚实 no-op（`NO_DATA_NO_HARD_FILTER`）·
    `validateRecommendation` 不变式 · Manual/Override/Router 共用派生视图 · `FilteredCandidateSet` 名义类型 ·
    ReasonCode producer 目录 · `snapshotVersion` 语义化。
  - **10A.0.3**：`snapshotVersion` **内容绑定**（`policyId@contentDigest`，时钟只进 `generatedAt`；弃用别名被忽略）·
    digest 分类规范化（集合排序 / **`preferredModels` 保序** / 数值 + 标量全覆盖，含 `mode/fallback/scope/policyId`）·
    视图顶层权威 `scopeType/scopeId/fallback`（无静默补洞）· `NO_ELIGIBLE_MODEL` 需真实拒绝证据 ·
    `FilteredCandidateSet` 收紧为带 brand 的数组（无未 brand 副本）· `SelectionRules` 导出并统一解释入口 ·
    `hybridCandidates`/`describeAutoPolicy` 收敛（共用 `rulesExcludeCandidate`）· `V1_NOT_RANKED` 标记挂条目 ·
    删除 `RANKING_HARD_CONSTRAINTS_LEGACY` · ReasonCode 计数修正为 **38** · 替换两条恒真测试 ·
    **发现并修复真实缺陷**：`createPolicy` 曾排序 `preferredModels`（破坏 0.25 权重信号的顺序语义）。
  - **测试**：`tests/sprint10a-0-2/contract-hardening.test.ts`（27 条）+ `tests/sprint10a-0-3/version-digest-hardening.test.ts`（26 条）；
    四套 router 测试合计 **84 条**。
- **Sprint 10A.0.4 交付结果（已完成，tag `sprint-10a.0.4`）— Final Closeout**
  - **唯一候选准入规则**：`evaluateCandidateAgainstSelectionRules` 成为唯一真相源（MANUAL/Override/HYBRID/AUTO/Router 共用），
    事实码→MANUAL refusal 与 事实码→Router ReasonCode 各一张映射表；消除 `UNKNOWN_CAPABILITY` vs `CAPABILITY_MISSING` 漂移。
  - **结构校验优先**：`validateRouterPolicyViewShape` 校验 15 个字段的存在性/类型/枚举 → 再规范化 → 再 digest → 再校验版本；
    非法与缺失一律 `VALIDATION_FAILED`，无 native 异常逃逸（含 Proxy 测试）。
  - **类型化 digest**：`null`/`undefined`/`num:`/`bool:`/`str:<len>:` + `set:`/`ord:` 前缀 ⇒ 无编码碰撞。
  - **真实冻结**：派生视图对象、`source` 与五个数组均 `Object.freeze`。
  - **测试修正 + 集成守卫**：`allowFallback` 真实篡改、语义化 missing 断言、引擎入口结构性守卫；
    `tests/sprint10a-0-4/final-closeout.test.ts`（A–R，32 条）；全仓 **88 文件 / 844 用例**。
- **Sprint 10A.0.5 交付结果（已完成，tag `sprint-10a.0.5`）— Mapping & Docs Truth Closeout**
  - **事实拆分**：`NOT_IN_ALLOWED_RANGE`（范围外，显式选择可豁免）与 `MODEL_BLOCKED_BY_POLICY`（硬阻断）成为两个事实；
    Router 映射分别为 `NOT_IN_CANDIDATE_SET` 与 `MODEL_BLOCKED`（ReasonCode 仍 38）。
  - **跨路径一致性**：测试真实调用 `deriveRouterPolicyView → applyHardFilters`（不再只查映射表）。
  - **异常边界**：`assertDerivedPolicyView` 全流程 try/catch（含"延迟抛错 Proxy"），只返回 `VALIDATION_FAILED`。
  - **Shape 收紧**：`scopeId` 类型/非空校验；`maxCost`/`maxLatency` 必须 finite。
  - **结构碰撞 + 运行时冻结**：集合/保序列表碰撞测试；`Object.isFrozen` 断言 + mutation 无效果。
  - **文档对账**：ADR/`MODEL_ROUTER.md`/handoff 计数与描述与代码一致；10A.0.3 与 10A.0.4 评审记录回填。
  - **测试**：`tests/sprint10a-0-5/mapping-truth-closeout.test.ts`（A–T，16 条）；全仓 **89 文件 / 860 用例**。
- **Sprint 10B 交付结果（实现完成，tag `sprint-10b.0.0`）— Deterministic Model Router v1**
  - **实现**：`createDeterministicModelRouter()`（engine）实现 `ModelRouterPort.recommend`，流水线
    `assertRouterRequestAllowed → applyHardFilters → rankCandidates → selectWinner → validateRecommendation → 审计`。
  - **排名**：Core 纯函数 `rankCandidates`，只读冻结权重，逐信号明细可解释，缺失即跳过并重归一化，
    稳定 tie-break（无 random/无时钟/无数据库顺序）。
  - **契约**：`CandidateEvaluation` 增加排名明细；`RouterDecisionRecord/StorePort` 下沉到 Core 端口。
  - **持久化**：`router_decisions` 迁移 + SQLite store + `router` 迁移链接入 durable 层。
  - **组合根**：桌面装配 Router，审计走结构化日志适配；Runtime 不构造/不调用 Router。
  - **测试**：`tests/sprint10b/router-implementation.test.ts`（A–AT，30 条）；全仓 **90 文件 / 890 用例**。
  - **10B.1（已完成，tag `sprint-10b.1.0`）— Router Reachability & Durable Audit**：组合根请求 `'router'` 链
    （三条既有边界断言改由 `tests/shared/expected-chains.ts` 单点维护）、`router.*` 事件 **durable** 发射
    （`defineEvent` + `events.append`，12 字段白名单）、`router.recommend` / `override.*` IPC（客户端只能给 scope）、
    `registryRevisionOf(records)` 内容绑定 revision、真实 provider health（unknown 不默认 healthy）、
    decision 有界持久化（top-20 + truncated）、重启可追溯、**非原子** ordering + `reconcileRouterAudit` 对账。
  - **测试**：`tests/sprint10b-1/`（链与表 3 条 + A–AP 21 条）；全仓 **92 文件 / 914 用例**；
    A–AP 套件抓到并修复一处真实 SQL 缺陷（注释吃掉 INSERT 收尾括号）。
  - **评审修复**：BLOCKER（override 审计未接线）· HIGH（对账文档过度声明、组合根接线无测试）·
    MEDIUM（NO_ELIGIBLE 顺序倒置、`effectiveBenchmarkWeight` 陈旧公式）全部关闭；
    剩余 LOW（接线断言为文本级、无 main.ts 行为级 E2E）记录待 10B.2。
- **Sprint 10B.2（已完成，tag `sprint-10b.2.0`）— Router Reachability E2E & Startup Reconciliation**
  - **行为级 E2E**：真实 SQLite + 真实组件全链（recommend/override → decision + 六个 `router.*` 事件落库）。
  - **启动对账**：`reconcileAndRepairRouterAudit` 正式接线于组合根，补发事件打标 `reconciled: true` /
    `repairReason: MISSING_RECOMMENDATION_EVENT`；三次启动幂等测试（1 → 0 → 0）。
  - **语义修正**：`totalCandidateCount`/`eligibleCandidateCount` 计数语义；provider health 5 分钟新鲜度
    （过期 → unknown）；`workflowId` 解析使 WORKFLOW policy scope 真实可达；IPC 单一 forbidden-key 校验入口。
  - **测试**：`tests/sprint10b-2/reachability-e2e.test.ts`（13 条）；全仓 **93 文件 / 927 用例**。
  - **评审修复**：HIGH（对账把 NO_ELIGIBLE 决策误判为缺事件并伪造补发 → 两种终态事件都算已审计 + 回归测试）、
    MEDIUM（blocked override 拒绝断言、`MODEL_ROUTER.md` 对账行与标题/§9/§17 陈旧声明、provider health 每次推荐前重观测、
    **崩溃缺口按决策结果补发同类型事件**：NO_ELIGIBLE → `router.no_candidate` + `MISSING_NO_CANDIDATE_EVENT`）、
    LOW（补发事件使用决策真实值、导出 repair 白名单）均已关闭。
- **Sprint 11（CLOSED，tag `sprint-11.0.0`）— Structured Handoff**
  - **生产接线（收口）**：组合根装配 `createHandoffService`（store 缺失即显式失败）、durable 六事件审计、
    `authz.assignmentsOf` 服务端派生角色、Handoff IPC 七操作、`previousHandoff` 仅由服务端从 durable ACCEPTED 派生、
    客户端角色声明与 `previousHandoff(Text)` 直传一律拒绝、`handoff` 行 + refs 同事务原子提交。
  - **测试**：`tests/sprint11/handoff.test.ts`（16）+ `tests/sprint11/production-wiring.test.ts`（A–O + 复核回归，8）；
    全仓 **95 文件 / 951 用例**。
  - **行为测试抓到并修复的真实缺陷**：① `INSERT OR IGNORE` 会静默吞掉非法 ref（改为普通 INSERT，非法即回滚）；
    ② 持久层冲突异常直接穿透 IPC（改为在服务层翻译为域错误 `ALREADY_EXISTS`/`PERSISTENCE_FAILED`）。
  - **契约**：`HandoffPacket`（33 字段）+ `HandoffRef`（artifact/decision/validation/execution）+ READY 必填/证据门 + 安全校验。
  - **独立状态机**：`DRAFT→READY→ACCEPTED|REJECTED`、`DRAFT|READY→CANCELLED`、
    `READY|ACCEPTED|REJECTED→SUPERSEDED`（唯一合法终态→终态迁移，只改 status）；与 L1/L2/L3/Execution/Invocation 完全独立。
  - **版本化**：`handoffVersion` + `supersedes` 链；终态内容不可改写（服务层 `CONFLICT` + 存储层条件 UPDATE 双保险）。
  - **权限**：`handoff.create/read/accept/reject`；accept 必须持 `toRoleId`（`WRONG_TARGET_ROLE`），创建者不能代收。
  - **持久化**：`handoff` 链（`handoffs` PK `(handoff_id, version)` + `handoff_refs`）；`createSqliteHandoffStore`；
    重复版本 `ALREADY_EXISTS`（不静默）；`DurableDatabase.handoffStore` 仅在该链启用时存在。
  - **durable audit**：六事件落库，payload **12 项白名单（含 `actorId`）**（无 summary/context/secret）。
  - **Runtime 投影**：仅 ACCEPTED 经 `handoffContextViewIfAccepted()` + `serializeHandoffContextView()` 进入
    `AgentContext.previousHandoff`；不自动启动 Agent / 推进 Workflow / 选 next role / 选 model / 选 tool。
  - **restart**：READY 与 ACCEPTED 跨重启保持，且不自动推进任何东西。
  - **E2E**：Developer → Reviewer；reject v1 → supersede v2 → accept v2（v1 历史与内容不变）。
  - **测试**：`tests/sprint11/handoff.test.ts`（16）+ `tests/sprint11/production-wiring.test.ts`（8）；
    全仓 **95 文件 / 951 用例**。
  - **本轮修复的真实缺陷**：存储层原先拒绝 `REJECTED/ACCEPTED → SUPERSEDED`（冻结机中的合法迁移）
    → 改为"内容列永不写入 + 仅放行该终态→终态迁移"。

## Sprint 10：Router

- **Phase**：Phase 2 ｜ **优先级**：P1 ｜ **依赖**：`sprint-9` ｜ **来源**：规划书 §五十九 Sprint 10、§二十六
- **目标**：按 Role、Capability、Risk、Quota、Cost、Availability 自动选模型。
- **Task**
  - T10.1 输入 Role（岗位需求）
  - T10.2 输入 Capability（能力要求）
  - T10.3 输入 Risk（风险等级影响选择）
  - T10.4 输入 Quota（额度约束）
  - T10.5 输入 Cost（成本约束）
  - T10.6 输入 Availability（可用性 / 健康）
  - T10.7 综合排序输出选择结果并留痕（规划书 §二十六 完整因子清单）
  - T10.8 支持质量优先 / 成本优先 / 速度优先三种取向（规划书 §十三）
- **Acceptance Criteria**
  - AC10.1 同一 Role 在不同约束下选中不同模型，且选择过程可解释
  - AC10.2 额度耗尽或不可用的模型不会被选中；Reviewer 默认与 Developer 使用不同模型（规划书 §二十）
  - AC10.3 选择结果写入事件流（MODEL_SELECTED，规划书 §四十三）
- **Tests**
  - `packages/router/tests/router.test.ts`：六因子逐一影响选择结果
  - `packages/router/tests/objective-weights.test.ts`：质量 / 成本 / 速度三种偏好
  - `packages/router/tests/reviewer-different-model.test.ts`：Reviewer 与 Developer 不同模型
- **Git Checkpoint**：`sprint-10`

## Sprint 11：Handoff

- **Phase**：Phase 2 ｜ **优先级**：P0（Handoff）｜ **依赖**：`sprint-10` ｜ **来源**：规划书 §五十九 Sprint 11、§二十八
- **状态**：**CLOSED**（tag `sprint-11.0.0`）。
- **目标**：目标角色正式接收结构化、有界、可追溯的 Handoff；接收事实与后续执行编排严格分离。
- **Task**
  - T11.1 定义 Handoff JSON（规划书 §二十八 全部字段，字段清单见对账文档）
  - T11.2 Agent 之间禁止依赖聊天上下文，必须结构化交接
  - T11.3 保存版本化 Handoff，并让目标角色显式 accept/reject；角色权限由服务端可信派生
  - T11.4 仅 ACCEPTED Handoff 可生成确定性、有界的 `previousHandoff` 投影，供后续执行显式消费
  - T11.5 禁止 Handoff 自行创建 Task、选择 next role/model/tool、调用 Router、启动 Agent、推进 Workflow 或继续 Stage
  - T11.6 Handoff 幂等（重复投递不重复生效）
  - T11.7 Handoff 事件入流（规划书 §四十三）
- **Acceptance Criteria**
  - AC11.1 **Handoff ACCEPTED 只表示目标角色正式接收结构化交接**；不表示任何执行动作已经发生
  - AC11.2 Handoff 结构包含规划书 §二十八 全部字段，缺字段即校验失败
  - AC11.3 交接内容可追溯且不依赖聊天上下文；后续自动编排属于其他 Sprint / Orchestrator 责任
- **冻结边界：ACCEPTED 不会自动**
  - select next role
  - select model
  - invoke Router
  - start Agent
  - advance Workflow
  - continue Stage
- **Tests**
  - `tests/sprint11/handoff.test.ts`：生命周期、版本化、权限、持久化、重启与有界投影
  - `tests/sprint11/production-wiring.test.ts`：真实 authz、durable audit、IPC 与 ACCEPTED-only 生产接线
- **Git Checkpoint**：`sprint-11.0.0`

## Sprint 12：Memory + Decision

> **当前实现状态（Codex）**：Sprint 12 核心契约、生命周期、确定性检索、SQLite `memory` 链、Engine 服务、授权 authorities、桌面 IPC、重启/原子性/provenance E2E 与 bounded projection 均已收口；Router/Handoff 冻结边界未改动。Sprint 13 已关闭。

- **Phase**：Phase 2 ｜ **优先级**：P1（Memory · Decision）｜ **依赖**：`sprint-11` ｜ **来源**：规划书 §五十九 Sprint 12、§二十九、§三十
- **目标**：知识不依赖聊天上下文，公司知识长期存在。
- **Task**
  - T12.1 实现 Company Memory（长期目标 / 规则 / 知识 / 战略）
  - T12.2 实现 Workflow Memory（SOP / Template / 版本 / 执行经验 / 性能数据）
  - T12.3 实现 Task Memory（当前任务 / Handoff / Decision / Artifacts / Validation）
  - T12.4 显式区分 Agent Context（临时、可丢失）（规划书 §二十九）
  - T12.5 实现 Decision Record：为什么这样决定 / 替代方案 / 为什么否决 / 哪些地方禁止重新设计 / 什么时候允许重新评估（规划书 §三十）
  - T12.6 重要信息进入 Database / Memory / Handoff / Decision Record / Artifact / Event / Workflow Template，不只留在模型 Context（规划书 §二 原则 8）
  - T12.7 Memory 读写在 Run Snapshot 约束下进行
- **Acceptance Criteria**
  - AC12.1 四层记忆可分别读写，均不依赖会话上下文
  - AC12.2 Decision Record 五问齐备，后到的模型不会不停推翻已验证决策（规划书 §三十）
  - AC12.3 Agent Context 丢弃后，Task Memory 与 Workflow Memory 仍可恢复任务，且可被后续 Run 复用（规划书 §六十四）
- **Tests**
  - `packages/memory/tests/memory-layers.test.ts`：四层读写与隔离
  - `packages/memory/tests/decision-record.test.ts`：五要素齐备
  - `packages/memory/tests/context-loss.test.ts`：丢弃上下文后任务可继续
- **Git Checkpoint**：`sprint-12`

## Sprint 13：Artifact + Validation

- **Phase**：Phase 2 ｜ **优先级**：P1（Artifact · Validation；Risk 同属 P1）｜ **依赖**：`sprint-12` ｜ **来源**：规划书 §五十九 Sprint 13、§三十一、§三十二
- **目标**：产出有物、质量有闸。
- **Task**
  - T13.1 实现 Artifact Lifecycle（所有阶段都可产生 Artifact，规划书 §三十一）
  - T13.2 实现 Validator（每个 Stage 可定义 Validator，规划书 §三十二）
  - T13.3 实现 Validation Result（记录结果）
  - T13.4 实现 Quality Gate（Validator 决定是否允许进入下一 Stage）
  - T13.5 登记 DevCompany Validator：UnitTest / Build / Lint / Typecheck / GitDiff（规划书 §三十二）
  - T13.6 登记 DevCompany Artifact：Code Diff / Test Result / Build Result / Commit / Architecture Document（规划书 §三十一）
  - T13.7 落地 Risk 四级模型 LOW / MEDIUM / HIGH / CRITICAL（规划书 §三十六），供 Sprint 24 使用
  - T13.8 Core 只认识 Artifact 与 Validation 抽象，具体类型属 Pack
- **Acceptance Criteria**
  - AC13.1 每个 Stage 可通过 Validator 决定是否放行；校验失败即阻断流转，事实来自真实结果而非 Agent 自述
  - AC13.2 Artifact 与 Validation Result 可被审计与引用
  - AC13.3 Risk 四级语义与规划书 §三十六 一致：LOW 自动、MEDIUM 自动 + 强制 Review、HIGH 执行前审批、CRITICAL 强制明确确认
- **Tests**
  - `packages/core/tests/artifact-lifecycle.test.ts`：产出 → 引用 → 审计
  - `packages/core/tests/validation-gate.test.ts`：Validator 结果决定流转
  - `packages/core/tests/risk-levels.test.ts`：四级风险语义
- **Git Checkpoint**：`sprint-13`
- **交付结果（已完成，tag `sprint-13.0.0`）**
  - T13.1–T13.4 落地为 Sprint 13A 冻结契约（`docs/sprint13/` 六份 + ADR-0015/0016）与 Sprint 13B
    的 12 个实现 Task：durable Artifact（不可变、SQLite+CAS 双 SoT、contentRef=`sha256:<hex>`、
    no-clobber hard-link 发布）、durable Validation（`targetRef` 绑定 ADR-0017、
    one command → one target → N validators）、Validator 经 Sprint 9 Tool Registry
    capability 门受控解析与执行、`VALIDATION.PASS` 证据门（ADR-0020：stage validatorIds =
    blocking-required，latest durable batch wins）。
  - T13.7 Risk 四级复用 Sprint 9 `RISK_POLICY`（validator 风险继承自 Tool Record，HIGH/CRITICAL 走既有审批）。T13.8 以
    `kind` 为 pack 定义的 opaque 字段落地（Core 零具体类型）。
  - 修正性 ADR：ADR-0017（target binding）· ADR-0018（durable replay output，tools/0004）·
    ADR-0019（tool version provenance，tools/0005）· ADR-0020（gate evidence selection）。
  - 生产组合：`userData/artifacts` 稳定 CAS 根、quiescent startup reconciliation（fatal → fail
    startup closed）、ArtifactService/ValidationService/EvidenceGuard/DurableReferenceResolver 全接线、
    内存 ARTIFACT/VALIDATION provenance 激活；Sprint 13 服务保持 main-process 内部能力（无 renderer IPC operation）。
  - 收口证据与已知限制见 `docs/SPRINT13_CLOSEOUT.md`。

## Sprint 14：Recovery

> **状态**：**CLOSED**（T14-01~T14-06 全部完成；ADR-0021/0022/0023 Accepted；证据链见
> `docs/SPRINT14_CLOSEOUT.md`；tag `sprint-14.0.0`。）

- **Phase**：Phase 2 ｜ **优先级**：P0（Recovery）｜ **依赖**：`sprint-13` ｜ **来源**：规划书 §五十九 Sprint 14、§四十五
- **目标**：失败是流程的一部分；系统能从中断处继续。
- **Task**
  - T14.1 模拟并恢复 App Crash（规划书 §四十五）
  - T14.2 模拟并恢复 API Error
  - T14.3 模拟并恢复 Quota 耗尽
  - T14.4 模拟并恢复 Tool Failure
  - T14.5 实现恢复路径：RECOVERING → Last Event → Workflow Run → Task → Handoff → Workspace → Artifact → Continue（规划书 §四十五）
  - T14.6 恢复过程不重新创建 Task、不重跑已完成 Stage（规划书 §二 原则 9）
  - T14.7 恢复动作留痕（RUN_INTERRUPTED / RUN_RECOVERED，规划书 §四十三）
- **Acceptance Criteria**
  - AC14.1 四类故障（Crash / API Error / Quota / Tool Failure）各有一条可复现恢复用例
  - AC14.2 恢复后从最近事件继续，已完成工作不重复，也不要求用户重新解释目标（规划书 §二 原则 9）
  - AC14.3 恢复事件可在事件流中查到
- **Tests**
  - `packages/core/tests/recovery-crash.test.ts`：崩溃后继续
  - `packages/core/tests/recovery-api-quota-tool.test.ts`：三种依赖故障后继续
  - `packages/core/tests/recovery-no-restart.test.ts`：恢复不重跑已完成 Stage
- **Git Checkpoint**：`sprint-14`
- **交付结果（已完成，tag `sprint-14.0.0`）**
  - 架构冻结（T14-01）：ADR-0021（quiescent 启动恢复编排：CAS 后/IPC 前、agent→tool→run、
    自动 interruption/禁 auto-retry、WAITING/PAUSED 零触碰、fail-closed、single-flight）、
    ADR-0022（依赖故障三禁令、显式续行、上下文保全）、ADR-0023（Workspace 非实体、恢复链冻结）。
  - 实现（T14-02）：`packages/engine/src/recovery/startup-recovery.ts` + `main.ts` 启动序接线
    （`composeCoreServices` 单实例抽取）；零新表列/零新 IPC/零新事件。
  - E2E（T14-03/04/05）：Crash（3-stage 真实重开、resumePoint、已完成 Stage 不重跑、
    RECOVERING/CAS-fatal/二次重启语义）；API Error/Quota（durable FAILED、启动零 provider、
    显式续行同 Run/Task）；Tool Failure（STARTED→INTERRUPTED→人工 retry 新 attempt、
    旧行不可变、attempt 2→3 lineage、replayOutput）。
  - AC14.1/14.2/14.3 全部满足；收口证据与已知限制见 `docs/SPRINT14_CLOSEOUT.md`。

## Sprint 15：Industry Pack Framework

/> **状态**：**CLOSED**（Task-15-07，2026-09-26：ADR-0024~0027 Accepted；T15-01~T15-06 全部 CLOSED，
> T15-07 收口完成。最终回归 122 文件/1387 用例全绿；收口记录 `docs/SPRINT15_CLOSEOUT.md`；
> tag `sprint-15.0.0` 指向最终 closeout HEAD（本地，未 push）。Sprint 16（DevCompany Pack）
> = pending，未经批准不得开工。Mission 不变。）

- **Phase**：Phase 2 ｜ **优先级**：P1（DevCompany Pack 前置框架）｜ **依赖**：`sprint-14` ｜ **来源**：规划书 §五十九 Sprint 15、§十五
- **目标**：让行业能力以 Pack 方式扩展，Core 保持行业无关。
- **Task**
  - T15.1 实现 Pack Loader（装载与版本固定）
  - T15.2 支持 Role Definitions（Pack 定义岗位）
  - T15.3 支持 Workflow Templates（Pack 提供模板）
  - T15.4 支持 Tool Requirements（Pack 声明工具需求）
  - T15.5 支持 Prompt Definitions（Pack 提供提示词）
  - T15.6 支持 Validator Definitions（Pack 定义校验器）
  - T15.7 支持 Risk Rules（Pack 定义风险规则）
  - T15.8 支持 Artifact Types（Pack 定义产物类型）
- **Acceptance Criteria**
  - AC15.1 一个 Pack 可声明规划书 §十五 的九类内容：Roles / Workflow Templates / Prompts / Tools / Validators / Artifacts / Risk Rules / Capability Rules / Templates
  - AC15.2 Pack 依赖 Core，Core 绝不依赖 Pack；Core 中不出现任何行业词
  - AC15.3 Pack 卸载后其能力全部消失，不留残迹；Pack 版本被固定进 Run Snapshot（规划书 §十一）
- **Tests**
  - `packages/core/tests/pack-loader.test.ts`：装载 / 卸载 / 版本固定
  - `packages/core/tests/pack-declarations.test.ts`：九类声明均可被解析
  - 边界测试：Core 无行业词、无 Pack 反向依赖
- **Git Checkpoint**：`sprint-15`

> **状态**：**PRODUCT CONTRACT FROZEN**（Task-16-01，2026-09-26：DevCompany/CodeFleet 产品合同
> 已冻结——身份 `dev-company@1.0.0`、五角色 logical keys 与最小权限 authorities（BOSS-FROZEN
> DERIVATION，未新增 authority）、`dev-company:delivery-cycle` 五阶段链、Developer/Reviewer 模型分离
> （logical `toolCalling` vs `reasoning`）、五 Prompt 合同、QA evidence 合同（PASS 需真实证据）、
> Tool/Validator requirements 标注 DECLARATIVE REQUIREMENT（runtime deferred to Sprint 17）、
> CapabilityRules/GenericTemplates 空类裁定、安装入口裁定（无自动安装/无 IPC/无 UI）。
> 契约三份见 `docs/sprint16/`。T16-02（创建 `packs/dev-company/`）未获批准前不得执行。）

> **状态**：**CLOSED**（Task-16-06，2026-09-26：T16-01 产品合同冻结 → T16-02 first-party Pack 包
> `packs/dev-company/`（`@companyos/pack-dev-company`，canonical manifest，九类 24 项声明）→
> T16-03 产品内容验证 → T16-04 边界/行业隔离/静态安全 → T16-05 真实 PackService 安装 + 物化 +
> Run pinning + 模型绑定（真实 Router）→ T16-06 全量审计与收口。最终回归 127 文件/1474 用例全绿；
> 收口记录 `docs/SPRINT16_CLOSEOUT.md`；annotated checkpoint tag **`sprint-16`**（本地，未 push）。
> **Sprint 17（Repository Runtime）= CLOSED**（收口 `docs/SPRINT17_CLOSEOUT.md`，annotated tag
> `sprint-17`，本地未 push）；DevCompany 的 tests/lint/typecheck/build/git diff/git status 可执行
> 兑现已由十个 repository 工具 + QA evidence validator 落地。）

## Sprint 16：DevCompany Pack

- **Phase**：Phase 3 ｜ **优先级**：P1（DevCompany Pack）｜ **依赖**：`sprint-15` ｜ **来源**：规划书 §五十九 Sprint 16、§十七
- **目标**：交付第一个行业 Pack：DevCompany（内部代号 CodeFleet）。
- **Task**
  - T16.1 定义 CTO 岗位（理解需求、选 / 设计 Workflow、定义 Sprint/Task/验收、判风险、最终验收；规划书 §十八）
  - T16.2 定义 Developer 岗位（编码 / UI / API / CRUD / Bug Fix / 普通重构 / 测试补充 / 文件修改；规划书 §十九）
  - T16.3 定义 Reviewer 岗位（Code Review / 架构一致性 / 潜在 Bug / 边界 / 状态一致 / 并发 / 异步 / 安全 / 测试不足 / 无关 Diff；规划书 §二十）
  - T16.4 定义 QA 岗位（真实运行 tests / lint / typecheck / build / git diff / git status；规划书 §二十一）
  - T16.5 定义 Documentation 岗位（README / API Docs / CHANGELOG / User Guide / Technical Documentation / Decision Summary；规划书 §二十二）
  - T16.6 定义 DevCompany Workflow Templates 与 Prompt / Validator / Risk Rules / Artifact Types
- **Acceptance Criteria**
  - AC16.1 五个岗位齐备（Chief/CTO、Developer、Reviewer、QA、Documentation），与规划书 §十七 的 MVP 角色一致
  - AC16.2 Reviewer 默认与 Developer 使用不同模型（规划书 §二十）；QA 结论来自真实命令结果，不是 LLM 自述（规划书 §二十一）
  - AC16.3 Pack 内所有行业词（含 Developer / CTO）不出现在 Core；DevCompany 内部代号 CodeFleet 仅在 Pack 内使用（规划书 §十六）
- **Tests**
  - `packs/dev-company/tests/roles.test.ts`：五个岗位定义与职责覆盖
  - `packs/dev-company/tests/prompt-validator.test.ts`：Prompt / Validator / Risk / Artifact 声明可装载
  - 边界测试：Core 仍无行业词
- **Git Checkpoint**：`sprint-16`

> **状态**：**ARCHITECTURE FROZEN**（Task-17-01，2026-09-26：ADR-0028 Accepted +
> `docs/sprint17/` 契约三份冻结。核心裁定：**不给 Agent 任意 shell**——Repository Runtime 由 trusted
> workspace root + RepositoryPathPolicy + fixed command profile + 权限/风险/审批 + 输出上限
> （16 KiB inline / 8 MiB capture + CAS 外置）+ RepositoryRevisionAnchor（HEAD+staged+unstaged+
> untracked）+ verifier-only QA evidence validator 共同包住；**不加 durable Repository/Workspace 实体、
> 不加 migration、不加 authority、不加 capability token**；Git V1 只读（status/diff/baseline，
> one ToolRecord `repo.git`，无 push）；DevCompany 六个冻结 tool ID 不变（remains 1.0.0）。
> **Sprint 17 = CLOSED**（T17-01~T17-09 全部 CLOSED；closeout 见 `docs/SPRINT17_CLOSEOUT.md`；annotated tag `sprint-17` 指向 closeout commit，本地未 push）。

## Sprint 17：Repository Runtime（**CLOSED**）

- **Phase**：Phase 3 ｜ **优先级**：P2（Git）｜ **依赖**：`sprint-16` ｜ **来源**：规划书 §五十九 Sprint 17、§四十七
- **目标**：让 Agent 能真正打开项目仓库并使用文件系统、搜索、终端、Git。
- **Task**
  - T17.1 实现 Open Repo（打开项目工作区）
  - T17.2 接入 Filesystem（读写文件，越界拒绝）
  - T17.3 接入 Search（代码 / 文本检索）
  - T17.4 接入 Terminal（受控命令执行）
  - T17.5 接入 Git（Task 开始记录 Branch / HEAD / Git Status / Dirty Files，规划书 §四十六）
  - T17.6 落地 Workspace 演进：V1 单 Workspace + 串行 Agent（规划书 §四十七）
- **Acceptance Criteria**
  - AC17.1 可打开真实项目并完成读 / 搜 / 改 / 执行命令
  - AC17.2 所有越界操作（工作区外路径）被拒绝；Git 操作不越过工作区边界，且不默认 Push（规划书 §四十六）
  - AC17.3 行业实现（Git / Repository）只存在于 Pack 内
- **Tests**
  - `packs/dev-company/tests/workspace.test.ts`：打开 → 读 → 搜 → 改 → 执行
  - `packs/dev-company/tests/path-escape.test.ts`：越界被拒
  - `packs/dev-company/tests/git-baseline.test.ts`：Task 开始记录分支 / HEAD / 状态 / 脏文件
- **Git Checkpoint**：`sprint-17`

## Sprint 18：Autonomous Supervisor & Corrective Loop

> **Mission 更正（T18-01/T18-02，Boss 裁定）**：本 Sprint 的正式使命是 **Autonomous Supervisor & Corrective
> Loop**（监督者决策与纠正回路 + 可信执行上下文）。早期的 CTO Workflow 规划概念已被 T18-01 架构冻结取代
> （superseded by the T18-01 architecture freeze）；**CTO 不等于 Supervisor**（ADR-0029 Decision 1），
> 不另开第二条 Sprint 18 路线。早期语境收在下方历史块中作为记录。DevCompany 的 CTO 角色/模板选择能力
> 仍属于 pack 层产品范围，由未来 Task 显式规划。

- **Phase**：Phase 3 ｜ **优先级**：P1 ｜ **依赖**：`sprint-17` ｜ **来源**：规划书 §五十九 Sprint 18 段（经冻结）、§二 原则 5/11/12、§八、§十八
- **目标**：在既有 Core/Engine/Persistence 之上交付 run 范围内的 Supervisor 决策与纠正回路语义——可审计的决策账本、retry 与 corrective 的严格分离、review 与 QA 的分层、停止条件与人工升级、崩溃安全的幂等——以及 Supervisor 醒来时必须拿到的三个可信事实（Run Goal / 不可变 RunSnapshot / run-pinned model bindings）。
- **Task（冻结顺序，逐 Task Boss 批准）**
  - T18-01 Architecture Recon & Contract Freeze（**CLOSED**）
  - T18-02 Durable Run Goal + Snapshot Verification + Model Binding Pinning（执行上下文基础设施）
  - T18-03 Durable Supervisor Decision Sink（DecisionStore 的第一个 production 写者，**CLOSED**）
  - T18-04 Structured Reviewer Findings & Durable Review Report（**CLOSED**：execution-bound，见 ADR-0029 corrective）
  - T18-05 Controlled Corrective Task Provisioning + Durable Lineage（**CLOSED**）
  - T18-07 Bounded Autonomous Supervisor Loop & Stop Conditions（**CLOSED**：一次有界编排周期——T18-06 原样复用 + Decision Applicator + `maxSupervisorTurns=20` / `maxCorrectiveRounds=3`（cap 在 T18-05 provisioner 边界）+ application receipt 永久幂等 + COMPLETE/ESCALATE 只经既有 Engine 命令 + 人工等待复用既有 Approval seam + resumeEscalatedRun；`HANDLER_OUTPUT_CARRIER_GAP` 诚实保留 OPEN）
  - T18-06 Supervisor Decision Runtime（**CLOSED**：一次有界 turn——load Run/Goal → 校验 snapshot → 解析 pinned binding → 有界 SupervisorContext → durable AgentExecution → 模型调用一次（结构化契约，**零 tool / 零 spawn**）→ 严格解析 → 语义前置校验 → 经 T18-03 sink 落 Decision → complete execution；全 turn 可取消/可超时，提交前取消零 Decision、提交后取消仍幂等）
  - T18-07 Corrective Loop + Stop Conditions + Human Escalation
  - T18-08 Crash Safety / Idempotency / Recovery
  - T18-09 DevCompany Integration + Autonomous Production E2E
  - T18-10 Sprint 18 Closeout
- **Acceptance Criteria**
  - AC18.1 Supervisor 是通用 orchestration runtime，不等于 DevCompany CTO；engine 无 `if role === CTO`（ADR-0029 D1/D12）
  - AC18.2 Supervisor 不是 root/admin：不经 authority 目录、不绕过 ToolRegistry / RiskPolicy / approvals / ValidationService / EvidenceGuard / frozen WorkflowVersion（ADR-0029 D2/D3）
  - AC18.3 Retry != Corrective；corrective 由受信 application/orchestration provisioning 创建，provenance durable 且幂等（ADR-0029 D4/D5/D7）
  - AC18.4 Reviewer semantic finding != QA evidence（T18-04 已冻结 review report 契约与 writer）；Supervisor 不能自批；停止条件命中必须升级人类（ADR-0029 D8/D9/D10）
  - AC18.5 V1 不加 task creation authority / Tool；Run-pinned WorkflowVersion/RunSnapshot 保持不可变（ADR-0029 D6/D11）
  - AC18.6 Run Goal / Snapshot 校验 / model binding pinning 全部复用既有持久化原语，零 migration（T18-02）
  - AC18.7 Supervisor 决策 turn 不执行决策：只经 T18-03 sink 记录，零 corrective provisioning / 零 engine advance / 零 tool / 零 subagent；binding 只来自 RunSnapshot（T18-06）
- **Tests**（冻结矩阵见 `docs/sprint18/S18_TEST_STRATEGY.md`）
  - `tests/sprint18/run-goal.test.ts`：canonical goal 的持久性 / 不可变 / 幂等 / 隔离
  - `tests/sprint18/run-snapshot-verification.test.ts`：篡改 / 缺失快照 fail closed
  - `tests/sprint18/model-binding-pinning.test.ts`：binding 受信 / 不可变 / 无默认
  - `tests/sprint18/production-execution-context.test.ts`：生产入口接线
  - `tests/sprint18/supervisor-decision-runtime.test.ts`：52 项矩阵（binding/execution、context、proposal、零副作用、取消/超时）
  - `tests/sprint18/supervisor-decision-runtime-production.test.ts`：生产 E2E 四条（review 失败 / QA 失败 / COMPLETE / restart 重放）
- **Git Checkpoint**：`sprint-18`

### ZCode 参考侦察结论（独立只读侦察，Boss PASS/CLOSED）

结论：**CompanyOS 主路线 KEEP**——不为 Sprint 18 改道、不复制 ZCode 源码、不依赖 ZCode 包。
Sprint 18 只吸收两条约束，其余明确不采用：

- **吸收 1（T18-06 已落地）**：cancellation/timeout 必须覆盖 Supervisor 从 context setup → model execution → parse → decision persistence 的完整生命周期（`AbortSignal` + 注入式 deadline，见契约 §12.9）。
- **吸收 2（T18-06 已落地）**：Supervisor V1 在**构造上**禁止 nested/subagent dispatch 与 tool 使用（不靠 prompt 说"不要派 Agent"：本模块不依赖 tool registry、不声明 descriptors、不跑 tool round）。
- **不采用**：arbitrary shell hooks（7 事件任意外壳命令）、无文件系统沙箱、in-memory runtime task registry（弱于我方 durable store）、yolo 权限绕过、weak path isolation。
- **延后（显式不在 Sprint 18）**：corrective depth / `maxCorrectiveRounds` hard limit ⇒ T18-07；T18-08 fault injection ⇒ 原计划；architecture-policy 机器门禁 ⇒ post-Sprint 18；context compaction ⇒ 未来；remote agent harness ⇒ 未来。

<details>
<summary>历史语境（已被 T18-01 取代的早期 CTO Workflow 规划，仅作记录）</summary>

- **目标**：用户只表达目标，CTO 决定用哪套 SOP。
- **Task**：T18.1 优先搜索已有 Workflow（规划书 §八）→ T18.2 有合适模板 → 选择并实例化 Run → T18.3 无合适模板 → 创建 Draft 或提出新流程 → T18.4 根据当前项目对模板做**有限微调**（不允许每次从头发明，规划书 §二 原则 12）→ T18.5 输出 Plan → T18.6 输出 Task → T18.7 输出 Risk / Capability / Acceptance Criteria
- **Acceptance Criteria**：AC18.1 相似需求第二次出现时复用已有模板，不重新设计（规划书 §六十 Case 2）；AC18.2 新业务无模板时才创建 Draft，并走 Review → Publish v1.0 → 创建 Run（规划书 §六十 Case 1）；AC18.3 CTO 负责想、Orchestrator 负责管；CTO 不负责持续调度，也不能随意越过 Orchestrator 改变系统状态（规划书 §二 原则 5）
- **Tests**：`packs/dev-company/tests/cto-workflow-select.test.ts` 命中模板即复用；`cto-workflow-draft.test.ts` 未命中即建 Draft 并 Publish；`cto-output.test.ts` Plan / Task / Risk / Capability / AC 五类输出齐备

</details>

## Sprint 19：Developer

- **Phase**：Phase 3 ｜ **优先级**：P2（Developer）｜ **依赖**：`sprint-18` ｜ **来源**：规划书 §五十九 Sprint 19、§十九
- **目标**：Developer 做真实代码修改。
- **Task**
  - T19.1 按 Acceptance Criteria 实施代码修改
  - T19.2 遵守工作区与权限边界（只能改被授权的路径）
  - T19.3 产出 Code Diff Artifact（规划书 §三十一）
  - T19.4 补充测试（规划书 §十九）
  - T19.5 控制修改范围，避免无关 Diff（供 Reviewer 检查，规划书 §二十）
  - T19.6 通过 Handoff 把 Diff / Constraint / Acceptance Criteria 交给 Reviewer
- **Acceptance Criteria**
  - AC19.1 Developer 产出真实代码变更而非文字描述；变更范围与 Task 声明一致，无越界修改
  - AC19.2 Diff 作为 Artifact 可追溯（谁改、何时、用何模型）
  - AC19.3 修改受 Run Snapshot 的 Stage / Role / Capability 约束
- **Tests**
  - `packs/dev-company/tests/developer.test.ts`：按 AC 产出真实 Diff
  - `packs/dev-company/tests/developer-scope.test.ts`：越界修改被拒
  - `packs/dev-company/tests/developer-artifact.test.ts`：Diff 入库并可追溯
- **Git Checkpoint**：`sprint-19`

## Sprint 20：Reviewer

- **Phase**：Phase 3 ｜ **优先级**：P2（Reviewer）｜ **依赖**：`sprint-19` ｜ **来源**：规划书 §五十九 Sprint 20、§二十
- **目标**：独立 Review，且默认换模型。
- **Task**
  - T20.1 独立执行 Code Review（默认与 Developer 不同模型，规划书 §二十）
  - T20.2 检查架构一致性
  - T20.3 检查潜在 Bug 与边界条件
  - T20.4 检查状态一致性 / 并发 / 异步
  - T20.5 检查安全与测试不足
  - T20.6 检查无关 Diff，并给出 PASS / REQUEST_CHANGES 结论
- **Acceptance Criteria**
  - AC20.1 Reviewer 使用与 Developer 不同的模型
  - AC20.2 Review 结论只有 PASS / REQUEST_CHANGES 两态且必须给出理由；Reviewer 单独说「代码没问题」不足以定 PASS，必须结合 Diff / Validation / Tool Result（规划书 §二 原则 7）
  - AC20.3 Reviewer 无写权限（规划书 §三十九）
- **Tests**
  - `packs/dev-company/tests/reviewer.test.ts`：PASS / REQUEST_CHANGES 两态
  - `packs/dev-company/tests/reviewer-different-model.test.ts`：与 Developer 不同模型
  - `packs/dev-company/tests/reviewer-readonly.test.ts`：无写权限
- **Git Checkpoint**：`sprint-20`

## Sprint 21：QA

- **Phase**：Phase 3 ｜ **优先级**：P2（QA）｜ **依赖**：`sprint-20` ｜ **来源**：规划书 §五十九 Sprint 21、§二十一
- **目标**：QA 用真实工具产出唯一可信的事实。
- **Task**
  - T21.1 运行 tests
  - T21.2 运行 lint
  - T21.3 运行 typecheck
  - T21.4 运行 build
  - T21.5 运行 git diff
  - T21.6 运行 git status（规划书 §二十一）
  - T21.7 记录真实结果（Exit Code 与输出）作为 Validation Result
- **Acceptance Criteria**
  - AC21.1 六项检查全部由真实命令执行，结论以 Exit Code 为准
  - AC21.2 Agent 自述「测试已通过」不构成事实（规划书 §二 原则 7）
  - AC21.3 任一检查失败即阻断后续 Commit（配合 Sprint 22 Rework Loop）
- **Tests**
  - `packs/dev-company/tests/qa.test.ts`：六项检查逐一执行并记录 Exit Code
  - `packs/dev-company/tests/qa-truth-source.test.ts`：结论取自真实结果而非模型自述
  - `packs/dev-company/tests/qa-blocking.test.ts`：失败即阻断
- **Git Checkpoint**：`sprint-21`

## Sprint 22：Rework Loop

- **Phase**：Phase 3 ｜ **优先级**：P2（Rework）｜ **依赖**：`sprint-21` ｜ **来源**：规划书 §五十九 Sprint 22、§三十五
- **目标**：Review Fail 自动返工；失败是流程的一部分。
- **Task**
  - T22.1 实现返工路径：Reviewer → REQUEST_CHANGES → Handoff → Developer → Fix → Reviewer（规划书 §三十五）
  - T22.2 实现最大返工次数上限：默认 3 次（规划书 §三十五）
  - T22.3 超过上限转 PAUSED，交给 Chief 或用户重新决策（规划书 §三十五）
  - T22.4 返工全过程记录事件与 Artifact（REWORK_STARTED 等，规划书 §四十三）
  - T22.5 返工不重建 Task、不重跑无关 Stage
  - T22.6 返工次数计入 Workflow Metrics 的「平均返工次数」（规划书 §十二）
- **Acceptance Criteria**
  - AC22.1 Review Fail 触发自动返工，不需要用户介入（规划书 §六十 Case 4）
  - AC22.2 达到 3 次上限后流程进入 PAUSED 并上报
  - AC22.3 返工不产生重复 Task、不丢失历史，返工次数可统计（供 Sprint 27）
- **Tests**
  - `packs/dev-company/tests/rework.test.ts`：REQUEST_CHANGES → 修复 → 复审
  - `packs/dev-company/tests/rework-limit.test.ts`：3 次上限后 PAUSED
  - `packs/dev-company/tests/rework-history.test.ts`：返工历史完整
- **Git Checkpoint**：`sprint-22`

## Sprint 23：Git Commit

- **Phase**：Phase 3 ｜ **优先级**：P2（Git）｜ **依赖**：`sprint-22` ｜ **来源**：规划书 §五十九 Sprint 23、§四十六
- **目标**：只有全部 PASS 才允许自动 Commit；默认禁止 Push。
- **Task**
  - T23.1 校验闸门：Review PASS + QA PASS + Acceptance PASS 三项全过才允许 Commit（规划书 §四十六）
  - T23.2 校验 Expected Diff 与真实 Diff 一致
  - T23.3 执行自动 Commit（MVP 允许）
  - T23.4 **禁止默认 Push**
  - T23.5 记录 Commit 作为 Artifact（规划书 §三十一）
  - T23.6 Commit 前记录 Branch / HEAD / Git Status / Dirty Files 基线
- **Acceptance Criteria**
  - AC23.1 QA Fail 时禁止 Commit（规划书 §六十 Case 5）
  - AC23.2 三项 PASS 齐备才自动 Commit（规划书 §五十九 Sprint 23 验收）
  - AC23.3 默认不 Push，任何 Push 需显式授权；Diff 与预期不符时拒绝 Commit
- **Tests**
  - `packs/dev-company/tests/git-commit.test.ts`：三 PASS 后自动 Commit
  - `packs/dev-company/tests/git-commit-blocked.test.ts`：任一失败即禁止 Commit
  - `packs/dev-company/tests/git-no-push.test.ts`：默认不 Push
- **Git Checkpoint**：`sprint-23`

## Sprint 24：Approval

- **Phase**：Phase 3 ｜ **优先级**：P0（Approval）｜ **依赖**：`sprint-23` ｜ **来源**：规划书 §五十九 Sprint 24、§三十四、§三十七、§五十一
- **目标**：人只参与高价值决策，四级风险分级落地。
- **Task**
  - T24.1 实现 LOW：自动执行
  - T24.2 实现 MEDIUM：自动执行 + 强制 Review
  - T24.3 实现 HIGH：需要人工批准
  - T24.4 实现 CRITICAL：必须明确确认
  - T24.5 落地 DevCompany HIGH 清单：Database Migration / Authentication / Payment / Concurrency / Core State / Architecture Rewrite / Large Refactor / Major Dependency Upgrade（规划书 §三十七）
  - T24.6 落地 DevCompany CRITICAL 清单：Production Database / Mass Delete / Force Push / Secret Changes / Production Deployment（规划书 §三十七）
  - T24.7 实现运行模式：Auto / Guided / Risk Controlled（推荐默认）（规划书 §五十一）
- **Acceptance Criteria**
  - AC24.1 四级风险的执行策略与规划书 §三十六 完全一致
  - AC24.2 HIGH 风险操作在审批通过前不得执行（规划书 §六十 Case 6）；CRITICAL 必须明确确认，无默认放行
  - AC24.3 审批结果被审计（APPROVAL_REQUIRED 等事件，规划书 §四十三）
- **Tests**
  - `packages/core/tests/approval-levels.test.ts`：四级策略
  - `packs/dev-company/tests/high-risk-list.test.ts`：HIGH 八项拦截
  - `packs/dev-company/tests/critical-risk-list.test.ts`：CRITICAL 五项强制确认
- **Git Checkpoint**：`sprint-24`

## Sprint 25：Provider Failover

- **Phase**：Phase 3 ｜ **优先级**：P2（Provider Failover）｜ **依赖**：`sprint-24` ｜ **来源**：规划书 §五十九 Sprint 25、§二十七
- **目标**：模型额度不足就换模型继续，Run 不丢。
- **Task**
  - T25.1 检测额度耗尽 / 不可用（Quota = 0 等场景）
  - T25.2 保存 Run → 生成 Handoff → Router 重新排名 → 选择另一模型（规划书 §二十七）
  - T25.3 继续当前 Stage（不得重新创建 Task）
  - T25.4 供应商异动（升级 / 降级 / 涨价 / 降价 / 没额度 / 宕机 / 速度变化 / 能力变化 / 供应商变化）下系统仍正常运行（规划书 §二 原则 2）
  - T25.5 失败转移留痕并可统计
  - T25.6 与 Sprint 14 Recovery 的故障恢复路径保持一致
- **Acceptance Criteria**
  - AC25.1 模型 Quota = 0 时自动换模型，Run 不丢（规划书 §六十 Case 7）
  - AC25.2 换模型后从 Handoff 继续原 Task，而不是重做；不要求用户重新解释目标
  - AC25.3 切换过程可审计（MODEL_SELECTED 等事件）
- **Tests**
  - `packages/router/tests/failover.test.ts`：额度耗尽后切换并继续
  - `packages/router/tests/failover-no-task-recreate.test.ts`：不重建 Task
  - `packages/router/tests/failover-audit.test.ts`：切换留痕
- **Git Checkpoint**：`sprint-25`

## Sprint 26：Crash Recovery E2E

- **Phase**：Phase 3 ｜ **优先级**：P0（Recovery）｜ **依赖**：`sprint-25` ｜ **来源**：规划书 §五十九 Sprint 26、§四十五
- **目标**：端到端证明「修改中强制关闭软件，恢复继续」。
- **Task**
  - T26.1 构造端到端场景：Developer 修改过程中强制关闭软件
  - T26.2 重启后按 RECOVERING → Last Event → Workflow Run → Task → Handoff → Workspace → Artifact → Continue 恢复
  - T26.3 验证工作区状态（Branch / HEAD / Dirty Files）在恢复后一致
  - T26.4 验证未完成 Stage 继续执行、已完成 Stage 不重跑
  - T26.5 验证恢复后 Commit 闸门仍生效（三 PASS 未齐不得提交）
  - T26.6 记录恢复事件与审计链
- **Acceptance Criteria**
  - AC26.1 强制关闭后可恢复到中断前的一致状态（规划书 §五十九 Sprint 26 验收、§六十 Case 8）
  - AC26.2 无数据丢失、无重复执行、无用户重新解释
  - AC26.3 恢复过程全程留痕；恢复耗时待 Sprint 26 验证（不预填数字）
- **Tests**
  - `packs/dev-company/tests/e2e-crash-recovery.test.ts`：中断 → 重启 → 继续 → 完成
  - `packs/dev-company/tests/e2e-workspace-consistency.test.ts`：工作区基线一致
  - `packages/core/tests/recovery-audit.test.ts`：恢复留痕
- **Git Checkpoint**：`sprint-26`

## Sprint 27：Workflow Metrics

- **Phase**：Phase 4 ｜ **优先级**：P3（Workflow Metrics）｜ **依赖**：`sprint-26` ｜ **来源**：规划书 §五十九 Sprint 27、§十二
- **目标**：每个 Workflow Template 持续积累运行指标，为 SOP 进化提供事实。
- **Task**
  - T27.1 统计成功率
  - T27.2 统计成本
  - T27.3 统计耗时
  - T27.4 统计返工次数
  - T27.5 统计失败 Stage（最容易失败 / 最慢 / 最贵）
  - T27.6 补齐规划书 §十二 的 14 项指标：运行次数 / 成功率 / 失败率 / 平均完成时间 / 平均成本 / 平均 Token / 平均返工次数 / 人工介入率 / 最容易失败的 Stage / 最慢 Stage / 最贵 Stage / 常用模型 / Reviewer 退回率 / 最终用户满意度
  - T27.7 指标写入 `workflow_performance_metrics`（规划书 §五十六）并可由事件重建
- **Acceptance Criteria**
  - AC27.1 14 项指标全部可计算或明确标注「数据不足」（不造数）
  - AC27.2 指标是只读投影，不能反向修改 Workflow 状态
  - AC27.3 指标可从事件日志重建且结果一致；首份真实指标值待 Sprint 27 验证（不预填数字）
- **Tests**
  - `packages/core/tests/metrics-14.test.ts`：14 项逐一可计算
  - `packages/core/tests/metrics-rebuild.test.ts`：事件重建结果一致
  - `packages/core/tests/metrics-readonly.test.ts`：写指标不改工作流状态
- **Git Checkpoint**：`sprint-27`

## Sprint 28：Workflow Optimization Proposal

- **Phase**：Phase 4 ｜ **优先级**：P3（Workflow 自动优化建议）｜ **依赖**：`sprint-27` ｜ **来源**：规划书 §五十九 Sprint 28、§十三、§十四
- **目标**：Chief 基于历史 Metrics 提优化建议，但**不能自动改模板**。
- **Task**
  - T28.1 基于 Metrics 识别瓶颈（失败集中 Stage / 成本异常 Stage / 返工集中 Stage）
  - T28.2 生成 Change Proposal（规划书 §十四）
  - T28.3 支持质量优先 / 成本优先 / 速度优先三种优化取向（规划书 §十三）
  - T28.4 强制路径：Proposal → Draft 新版本 → A/B 或小范围测试 → Publish（规划书 §十四）
  - T28.5 **禁止自动直接修改 Template**（规划书 §五十九 Sprint 28）
  - T28.6 走 Fork → 新版本发布，原版本保持可审计
- **Acceptance Criteria**
  - AC28.1 系统累计多次 Run 后，Metrics 能指出经常失败的 Stage（规划书 §六十 Case 9）
  - AC28.2 Chief 只能提出 Change Proposal，不能直接改原版本（规划书 §六十 Case 9）
  - AC28.3 优化必须经 Fork → 新 Draft → Review → Publish 闭环，且优化建议可追溯
- **Tests**
  - `packages/core/tests/optimization-proposal.test.ts`：瓶颈识别 → 生成 Proposal
  - `packages/core/tests/optimization-no-direct-edit.test.ts`：直接改模板被拒
  - `packages/core/tests/optimization-publish-flow.test.ts`：Fork → Draft → Publish 闭环
- **Git Checkpoint**：`sprint-28`

## Sprint 29：Desktop UI

- **Phase**：Phase 4 ｜ **优先级**：P2（Desktop Workflow UI · Workflow Library UI）｜ **依赖**：`sprint-28` ｜ **来源**：规划书 §五十九 Sprint 29、§四十八、§五十
- **目标**：把公司运行情况可视化，用户感觉「我的公司正在完成任务」。
- **Task**
  - T29.1 实现 Workflow Timeline（中部主视图，规划书 §四十八）
  - T29.2 实现 Agent Fleet（右侧）与顶部信息条 Workflow Version / Risk / Cost / Provider Health / Current Stage
  - T29.3 实现 Task 视图
  - T29.4 实现 Events 视图
  - T29.5 实现 Cost 视图
  - T29.6 实现 Approval 视图
  - T29.7 实现 Validation 视图
  - T29.8 实现 Workflow Library（Workflow Name / Industry Pack / Version / Status / Success Rate / Usage Count / Average Cost / Average Duration / Last Updated；支持 Use / Fork / View Metrics / Deprecate / Compare Versions，规划书 §五十）
  - T29.9 实现 Workflow Version 视图与底部页签 Events / Artifacts / Handoff / Validation / Terminal / Cost / Workflow Metrics
- **Acceptance Criteria**
  - AC29.1 规划书 §四十八 的左 / 中 / 右 / 顶 / 底五区信息齐备；左侧含 Companies / Industry Packs / Projects / Workflow Templates / Workflow Runs
  - AC29.2 Workflow Library 九列 + 五种操作可用（规划书 §五十）
  - AC29.3 指标为真实数据；无数据时显示空态，不显示编造值
- **Tests**
  - `apps/renderer/tests/timeline.test.ts`：时间线渲染与实时更新
  - `apps/renderer/tests/agent-fleet.test.ts`：Agent 视图
  - `apps/renderer/tests/workflow-library.test.ts`：九列 + 五操作
- **Git Checkpoint**：`sprint-29`

## Sprint 30：MVP Hardening

- **Phase**：Phase 4 ｜ **优先级**：P0（收敛验收）｜ **依赖**：`sprint-29` ｜ **来源**：规划书 §五十九 Sprint 30、§六十、§六十一
- **目标**：真实项目完整验证，并做架构终极验收。
- **Task**
  - T30.1 用真实项目跑完整业务（规划书 §五十九 Sprint 30）
  - T30.2 回归规划书 §六十 Case 1：新业务无模板 → Draft → Review → Publish v1.0 → 创建 Run → 完整执行
  - T30.3 回归 Case 2：已有模板直接复用 + 有限微调
  - T30.4 回归 Case 3：v1.0 运行中发布 v1.1，在跑 Run 仍走 v1.0，新 Run 走 v1.1
  - T30.5 回归 Case 4 / Case 5：Reviewer Fail 自动返工；QA Fail 禁止 Commit
  - T30.6 回归 Case 6 / Case 7：HIGH 风险人工审批；模型 Quota = 0 自动换模型且 Run 不丢
  - T30.7 回归 Case 8 / Case 9：Crash 重启继续；Metrics 驱动 Change Proposal
  - T30.8 架构终极验收：禁止大改 Core，新增 **Mock ContentCompany Pack**（Workflow：Plan → Write → Review → Deliver；角色：Content Director / Writer / Reviewer）
  - T30.9 判定：若能仅新增 Pack 实现 → Core 行业抽象成功；若需大量改 Core → 回头修复架构（规划书 §六十一）
  - T30.10 补齐 P3 剩余项：自动绩效评分 / Worktree / 并行 Agent（规划书 §五十八 P3）
- **Acceptance Criteria**
  - AC30.1 真实项目完整验证通过（规划书 §五十九 Sprint 30）
  - AC30.2 规划书 §六十 九个 Case 全部可复现
  - AC30.3 Mock ContentCompany Pack 仅靠 Pack 落地，Core 无改动（规划书 §六十一）；若必须改 Core 才落地，则判定架构失败并冻结新功能先修架构
  - AC30.4 `packages/core/src/**` 仍无 §四 禁词；最终验收数字（成功率 / 成本 / 耗时）待 Sprint 30 验证（不预填）
- **Tests**
  - `packs/mock-content-company/tests/architecture-acceptance.test.ts`：仅新增 Pack 即可跑通 Plan → Write → Review → Deliver
  - `tests/e2e/mvp-cases.test.ts`：规划书 §六十 Case 1–9 端到端
  - `scripts/tests/core-untouched.test.ts`：新增 Mock Pack 前后 Core 源码无变化
- **Git Checkpoint**：`sprint-30`

## 交付状态说明

| 项 | 状态 | 说明 |
|---|---|---|
| 本路线图覆盖 | Sprint 0–30 共 31 个 Sprint、5 个 Phase | 名称与验收取自规划书 §五十九，优先级取自 §五十八 |
| 已关闭范围 | Sprint 0–16 | Sprint 10A / 10B / 10B.1 / 10B.2、Router 主线、Sprint 11 Handoff 主线、Sprint 12 Memory + Decision、Sprint 13 Artifact + Validation、Sprint 14 Recovery、Sprint 15 Industry Pack Framework 与 Sprint 16 DevCompany Pack 均已关闭；关闭证据见 `PROJECT_HANDOFF.md`、`PROJECT_EXECUTION_HANDOFF_TO_CODEX.md`、`docs/SPRINT13_CLOSEOUT.md`、`docs/SPRINT14_CLOSEOUT.md`、`docs/SPRINT15_CLOSEOUT.md` 与 `docs/SPRINT16_CLOSEOUT.md` |
| 当前 active sprint | 无（None） | 当前没有 active sprint；Sprint 13（tag `sprint-13.0.0`）/ Sprint 14 Recovery（tag `sprint-14.0.0`）/ Sprint 15 Industry Pack Framework（tag `sprint-15.0.0`，收口 `docs/SPRINT15_CLOSEOUT.md`）均已完成收口。下一 Sprint 为 Sprint 17（Repository Runtime，pending），未获用户正式开工批准前不得执行；禁止连续做到 Sprint 30 |
