# CompanyOS 产品计划（PRODUCT_PLAN）

> 本文件是 `AGENTS.md` 与 `docs/` 的**总入口摘要**。完整论证见规划书 `最终1.1.txt` 与
> `docs/EXECUTION_ROADMAP.md`；执行状态见 `PROJECT_HANDOFF.md`。
> 当前阶段：**Sprint 0（Foundation，P0）已交付**；Sprint 1 需用户确认后启动。

## 1. 产品定义

CompanyOS 是一个**按行业 SOP 组织多个可替换 AI 模型、Agent 与真实工具，协同完成业务目标的
AI 工作操作系统**（规划书 §一、§六十九）。

它解决的是：谁做什么、什么时候做、谁最适合做、采用哪套 SOP、什么标准算完成、谁负责审核、
失败交给谁返工、哪些事情必须人工批准，以及整个过程中知识、状态、规则、流程和决策如何长期
保存与持续进化。

核心资产不是模型接入数量，而是：

> **Workflow + SOP + Validation + Memory + Decision + Performance Data**（规划书 §四、§六十三）

## 2. 十二条不可违背的设计原则

见 `docs/PROJECT_CONSTITUTION.md`（逐条给出要求 / 禁止事项 / 落点 / 违规判定）。
摘要：用户是老板 · 模型只是员工 · Agent 是岗位 · Workflow 才是生产能力 · Chief 想/Orchestrator 管/Agent 干 ·
Orchestrator 是制度不是 AI · 真实结果优先于 AI 自述 · 知识不依赖聊天上下文 · 换模型任务不重来 ·
失败是流程的一部分 · 人只参与高价值决策 · 成熟 Workflow 不重复发明。

## 3. 架构骨架

七层（规划书 §三）：用户 → Desktop → Chief Agent → Workflow Lifecycle → Orchestrator
（Workflow Engine / Model Router / Risk·Approval）→ Agent Runtime → Industry Packs | Model Pool | Tool Pool。

Core 行业无关，只认识 23 个概念（规划书 §四）：Company, Industry Pack, Workflow, Workflow Template,
Workflow Version, Workflow Run, Stage, Task, Role, Agent, Artifact, Tool, Validation, Approval, Risk,
Event, Memory, Decision, Handoff, Provider, Model, Capability, Cost。

禁词（属于 Industry Pack）：`Coding` `Git` `Repository` `Developer` `CTO` `Article` `Video` `Ecommerce`。
详见 `docs/CORE_BOUNDARIES.md` 与 `docs/ARCHITECTURE_REVIEW.md`。

## 4. MVP 范围

必须实现与明确不做见 `docs/MVP_SCOPE.md`（对应规划书 §五十二 / §五十三）。
一句话：MVP = Core + Workflow Lifecycle/Version/Snapshot + Orchestrator + State Machine +
Provider/Model/Capability/Router + Agent Runtime + Tool Registry + Handoff + Memory + Decision +
Artifact + Validation + Risk + Approval + Events + Recovery + Cost + Desktop UI + DevCompany Pack；
**不做** ContentCompany/VideoStudio/EcommerceCompany、Cloud SaaS、Multi-user、Marketplace、Mobile、
复杂 RAG、Vector DB、Kubernetes、自动生产部署、超复杂并行 Agent。

## 5. 优先级与路线

| 优先级 | 主题 | Sprint |
|---|---|---|
| **P0** | 地基与 Core（Monorepo、Electron、SQLite、迁移、日志、测试、CI → Core Domain → Workflow Engine → Persistence → Lifecycle） | 0–4 |
| **P1** | Workflow Designer、Provider、Model Registry、Agent Runtime、Tool Registry、Router、Handoff、Memory/Decision、Artifact/Validation、Recovery | 5–15 |
| **P2** | Industry Pack 框架、DevCompany Pack、Repository Runtime、CTO/Developer/Reviewer/QA、Rework、Git、Approval、Failover、Crash Recovery | 16–26 |
| **P3** | Metrics、优化提案、Desktop UI、MVP Hardening | 27–30 |
| **P4** | 第二行业（ContentCompany）、Cloud、Marketplace、Team | post-1.1 |

完整 Task / Acceptance Criteria / Tests / Git Checkpoint 见 `docs/EXECUTION_ROADMAP.md`。

## 6. 每个 Sprint 的可验收定义

```powershell
pnpm install --frozen-lockfile
pnpm check          # 必须 Exit Code 0
pnpm test:scripts
git status --porcelain   # 必须为空
```

外加：文档更新、`PROJECT_HANDOFF.md` 更新、一次提交、零禁止项代码（见 `AGENTS.md` §3）。

## 7. 风险与纪律

- 禁止一次性开发全部系统；每个 Sprint 只做本 Sprint 范围（规划书 §六十六 STEP 6）。
- 已发布 Template 禁止原地修改；系统改动必须走 Change Proposal → 新版本（规划书 §十）。
- 真实结果优先：以 Exit Code / Diff / Tool Result 为验收依据（规划书 §七原则 7）。
- 已知风险与限制记录在 `PROJECT_HANDOFF.md`。
