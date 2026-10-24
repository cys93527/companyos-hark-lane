# CompanyOS MVP 范围

> 依据：规划书 §五十二（真正 MVP 范围）、§五十三（MVP 明确不做）、§六十（核心验收案例）、
> §六十一（架构终极验收）、§六十六（当前执行要求）。
> 优先级与 Sprint 映射见 `EXECUTION_ROADMAP.md`；日常纪律见 `../AGENTS.md`。

## MVP 必须实现

规划书 §五十二 原文清单，逐项给出归属 Sprint 区段与验收方式（Sprint 名称见 `EXECUTION_ROADMAP.md`）。

| # | 必须实现 | 归属 | 验收方式（命令 / 观察点） |
|---|---|---|---|
| 1 | CompanyOS Core（行业无关内核） | S1 | 边界门通过；Core 零运行时依赖 |
| 2 | Workflow Lifecycle（Draft/Publish/Version/Fork/Deprecate/Archive） | S4 | 已发布 Template 不可原地修改；旧 Run 不受新版本影响 |
| 3 | Workflow Template | S1、S4 | Template 可创建、发布、复用 |
| 4 | Workflow Version | S4 | 版本内容哈希稳定；版本只增不改 |
| 5 | Workflow Run Snapshot | S4 | 运行期固定 Template 快照；升级不影响进行中的 Run |
| 6 | Workflow Metrics 基础 | S27 | 成功率/成本/耗时/返工可查询 |
| 7 | DevCompany Pack | S16 | 仅新增 Pack 即获得 CTO/Developer/Reviewer/QA/Documentation |
| 8 | Workflow Engine | S2 | Transition/Retry/Pause/Resume/Loop/Branch/Failure 行为测试 |
| 9 | Orchestrator | S2、S18 | 状态推进由确定性程序决定，而非模型 |
| 10 | State Machine | S1、S2 | 17 全局态 + Template 生命周期，非法转移抛错 |
| 11 | Provider Layer | S6 | OpenAI/Anthropic/DeepSeek/OpenAI-Compatible 可切换 |
| 12 | Model Registry | S7 | Capability/Cost/Health/Quota/Availability 可配置 |
| 13 | Capability System | S7 | 能力画像可比较、可更新 |
| 14 | Model Router | S10 | 依据 Role/Capability/Risk/Quota/Cost/Availability 选模型 |
| 15 | Agent Runtime | S8 | Role + Prompt + Model + Tool + Structured Output |
| 16 | Tool Registry | S9 | 注册/权限/风险/执行/审计 |
| 17 | Handoff | S11 | A 执行 → 中途切 B → B 读 Handoff → 继续原 Task |
| 18 | Memory | S12 | Company/Workflow/Task/Agent Context 四层 |
| 19 | Decision Record | S12 | 决策不可被后续模型反复推翻 |
| 20 | Artifact | S13 | 阶段产物可追溯、可引用 |
| 21 | Validation | S13 | Validator 运行并记录结果，作为质量门 |
| 22 | Risk | S24 | LOW/MEDIUM/HIGH/CRITICAL 四级 |
| 23 | Approval | S24 | HIGH 需审批，CRITICAL 需明确确认 |
| 24 | Events | S3 | 事件持久化、可回放、可审计 |
| 25 | Recovery | S14、S26 | 崩溃/断电/API 错误/限流/额度耗尽后可恢复 |
| 26 | Cost | S27 | Provider/Model/Stage/Task/Role 维度成本可追溯 |
| 27 | Desktop UI | S29 | Workflow Timeline、Agent Fleet、Events、Cost、Approval、Validation、Library |

> 注：规划书 §五十二 是**目标态清单**；其中 Router、Agent Runtime、DevCompany Pack 等属于 P1，
> 当前 Sprint 0（地基）**禁止提前开发**，见 `../AGENTS.md` §3。

## MVP 明确不做

规划书 §五十三，逐项确认（出现即视为越界）：

| 不做 | 说明 |
|---|---|
| 正式 ContentCompany | 仅在 §六十一 用 **Mock Pack** 验证 Core 抽象，不做正式第二行业 |
| VideoStudio | 同上 |
| EcommerceCompany | 同上 |
| Cloud SaaS | MVP 为本地优先、单机 |
| Multi-user | 单用户，无账号体系 |
| Team Collaboration | 无多人协作/评论/权限组 |
| Marketplace | 无插件市场 |
| Mobile | 只做 Desktop |
| 复杂 RAG | 只做必要记忆检索 |
| Vector Database | MVP 不引入向量库 |
| Agent Farm | 不做大量并行 Agent 农场 |
| Kubernetes | 不做容器编排 |
| 自动生产部署 | 禁止自动 Push/部署生产 |
| 超复杂并行 Agent | V1 只做单 Workspace、串行 Agent（规划书 §四十七） |

## 验收案例

规划书 §六十 的九个案例，是 MVP 的**行为级验收**。

| Case | 场景 | 期望行为 | 验证方式 |
|---|---|---|---|
| 1 | 新业务，无模板 | Chief 创建 Workflow Draft → Review → Publish v1.0 → 创建 Run → 完整执行 | 观察 Draft → Publish → Run 生命周期事件链 |
| 2 | 已有模板 | Chief 不重新设计，直接复用 v1.0，仅按项目有限微调 | Run Snapshot 指向已发布版本 |
| 3 | 模板升级 | v1.0 正在运行，Chief 发布 v1.1：进行中的 Run 仍走 v1.0，新 Run 用 v1.1 | 对比两个 Run 的 Snapshot 版本 |
| 4 | Reviewer Fail | 自动返工（REQUEST_CHANGES → Handoff → Developer → Fix → Reviewer） | 返工计数增加；超过 3 次转 PAUSED |
| 5 | QA Fail | 禁止 Commit | 无 Commit 产生；Run 未进入 FINALIZING |
| 6 | HIGH Risk | 必须人工审批后才能执行 | 出现 WAITING_APPROVAL 且无审批不推进 |
| 7 | 模型 Quota = 0 | 自动换模型，Run 不丢 | Handoff 存在；Task 未重建；继续当前 Stage |
| 8 | 程序 Crash | 重启后继续（RECOVERING → Last Event → Run → Task → Handoff → Workspace → Artifact → Continue） | 进程被强杀后重启，Run 从上次事件继续 |
| 9 | Workflow 改进 | Metrics 显示某 Stage 常失败 → Chief 提出 Change Proposal → Fork 新版本 → Review → Publish；不能直接改原版本 | 原版本内容哈希不变，新版本产生 |

## Definition of Done

### 当前（Sprint 0）的 DoD

```powershell
pnpm install --frozen-lockfile   # 必须 Exit Code 0
pnpm check                       # lint → typecheck → boundaries → test → build，必须 Exit Code 0
pnpm test:scripts                # 边界门与仓库卫生自检
git status --porcelain           # 必须为空
```

### 架构终极验收（规划书 §六十一）

DevCompany MVP 完成后：**禁止大改 Core**。改为新增一个 Mock ContentCompany Pack，其 Workflow 为
`Plan → Write → Review → Deliver`，角色为 `Content Director / Writer / Reviewer`。

- 若**仅新增 Pack** 即可实现 → Core 行业抽象成功；
- 若需要修改大量 Core → 必须回头修复架构，再继续下一阶段。

### 全局 DoD（每个 Sprint 通用）

Plan → Implement → Test → Independent Review → Commit → Update Handoff；文档更新；
`PROJECT_HANDOFF.md` 更新；零禁止项代码（`../AGENTS.md` §3）。
