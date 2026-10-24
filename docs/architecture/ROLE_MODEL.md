# ROLE MODEL — frozen (V1 Execution Architecture Freeze §14)

CompanyOS-role ≠ AI 员工 ≠ 第二任务/工作流/会话/调度真相。Role 回答一个问题：
**“这项工作需要什么专业责任/视角？”**

## 既有规范属主（TERMINOLOGY EQUIVALENCE 已证）

| 概念 | 仓库规范载体 | 属主 |
|---|---|---|
| Work Role | `roles` / `role_assignments` 表；`taskProfile.roleId`（钉定版本节点 config，T20-03B）；Pack 角色声明（S16 DevCompany 五角色）；规划器 `rol.planner` / 监督 `supervisor` | Pack/钉定版本拥有业务意义；引擎仅消费 id |
| 专业视角到执行 | 角色只出现在三处：任务 profile（谁的工作）、模型绑定（哪个模型服务该角色轮）、上下文投影器（T19-04 review/qa 有界重建） | 组合/运行时 |

**结论：不新建 RoleProfile 域对象** —— Work Role 语义已由上述规范概念完整拥有。Role 是 Pack 声明的**部署数据**，不是运行时实体。

## Role 不是什么（冻结）

- 不是独立 AI 员工（无自有生命周期/无自有真相）
- 不是第二 Task / Workflow / Session truth / scheduler
- 模型绑定 ≠ 角色（一个角色可换模型；一个模型可服务多角色）
- Role 永不直接写 canonical 状态（一切经 runtime 权威）

## 端到端示例（§25）

用户白话：“我想做一个自动监测新发布话题内容并整理成可用素材的产品。”
ONE CompanyOS：Goal → Plan（多 plan item）→ 钉定 WorkflowVersion → Run → Task → Artifact → Validation。
专业视角全部落在 **plan item 的 taskProfile.roleId** 上：
`需求澄清(product)` → `调研(research)` → `架构(architecture)` → `实现(implementation)` → `评审/验收(review/qa)`。
能力路由示例：research→搜索/浏览能力；数据规整→native 数据/进程能力；复杂实现→agentic 软件工程能力；测试→native 进程能力；质量评审→推理+validation。
**每个“角色”都是同一 Plan/Workflow/Task/Run/Artifact/Validation 里的一个工作项** —— 没有平行世界。
