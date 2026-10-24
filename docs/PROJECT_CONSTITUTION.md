# CompanyOS 项目宪法

> 依据：规划书 §二（CompanyOS 项目宪法）。
> 本文件是**最高级设计原则**：任何未来功能都不得违背。违反者不是「实现得不好」，而是破坏了项目定义。
> 每条给出：要求 / 禁止事项 / 系统中的落点 / 违规判定方式。

## 原则 1：用户是老板

- **要求**：用户只表达「我要达到什么目标」。系统负责把它转换成
  `目标 → Workflow → Stage → Task → Role → Model → Tool → Review → Validation → Delivery`。
- **禁止**：要求用户选择模型、拼 prompt、手动拆任务、手动分派 Agent。
- **落点**：Chief Agent Layer（Sprint 18 CTO Workflow）；`docs/WORKFLOW_LIFECYCLE.md`。
- **违规判定**：任何「必须先配置模型才能开始任务」的流程设计即为违规。

## 原则 2：模型只是员工

- **要求**：GPT / Claude / DeepSeek / Gemini / Kimi 都是**可随时替换的 AI 劳动力**；升级、降级、
  涨价、降价、没额度、宕机、速度与能力变化、供应商变化都不影响系统正常运行。
- **禁止**：把某个 provider 的能力、配额或特性写成系统的隐含前提。
- **落点**：Provider Layer（Sprint 6）、Model Registry（Sprint 7）、Router（Sprint 10）。
- **违规判定**：出现「只有某模型才能完成 X」的硬编码分支即为违规。

## 原则 3：Agent 是岗位

- **要求**：设计 `Developer` / `Reviewer` / `Writer` / `Researcher` / `Analyst` / `Designer` / `Chief`
  这类**角色（Role）**；模型只是当前被安排到该岗位执行工作的人。
- **禁止**：设计 `Claude Agent` / `DeepSeek Agent` / `GPT Agent`。
- **落点**：Role 定义属于 Industry Pack（规划书 §十五）；Agent Runtime（Sprint 8）。
- **违规判定**：仓储中出现以 provider 命名的 agent 抽象即为违规。

## 原则 4：Workflow 才是公司的真正生产能力

- **要求**：让公司稳定运行的是流程、职责、权限、审核、记忆、工具、规则、质量标准与经验积累。
- **禁止**：把「模型更强」当作系统可靠性的主要来源。
- **落点**：Workflow Engine（Sprint 2）、Workflow Lifecycle（Sprint 4）。
- **核心资产定义**：`Workflow + SOP + Validation + Memory + Decision + Performance Data`。
- **违规判定**：一项功能若只增加模型能力、不沉淀任何流程/知识，则不属于 CompanyOS 的核心投资。

## 原则 5：CTO / Chief 负责设计，Orchestrator 负责执行

- **要求**：Chief 负责理解目标、判断业务流程、设计 Workflow、定义 Stage/岗位、拆 Task、定义验收标准、
  判断风险、提出修改建议；Orchestrator 只按已确定的 Workflow 执行。
- **禁止**：Chief 随意越过 Orchestrator 改变系统状态。
- **口诀**：**Chief 负责想。Orchestrator 负责管。Agent 负责干。**
- **落点**：Chief Agent Layer 与 Orchestrator Layer 的边界（`ARCHITECTURE.md`）。

## 原则 6：Orchestrator 是制度，不是 AI

- **要求**：Orchestrator 必须是**确定性程序系统**；管理 Workflow、State、Stage、Task、Agent、Model、
  Budget、Retry、Risk、Approval、Validation、Recovery、Concurrency。
- **禁止**：依赖某个模型临时决定「我觉得下一步可以开始了」。
- **落点**：`packages/core/src/lifecycle/machine.ts`（确定性状态机）+ Sprint 2 Workflow Engine。
- **违规判定**：状态推进依赖 LLM 输出而非状态机判定即为违规。

## 原则 7：真实结果优先于 AI 自述

- **要求**：Developer 说「测试已经通过」不构成事实；事实是 `test command Exit Code 0`。
  Reviewer 说「代码没问题」也不能单独决定 PASS，必须结合 Validation Result、Artifact、Tool Result、
  Diff、Audit、Rule。
- **禁止**：以自然语言断言作为验收证据。
- **落点**：Validation System（`VALIDATION_SYSTEM.md`，Sprint 13）、QA（Sprint 21）。
- **违规判定**：任何 PASS 判定缺少可复现命令或产物证据即为违规。

## 原则 8：知识不能依赖聊天上下文

- **要求**：Agent Conversation 是临时的；公司知识必须长期存在于 Database、Memory、Handoff、
  Decision Record、Artifact、Event、Workflow Template、Project Files。
- **禁止**：把关键状态只放在模型 context 里。
- **落点**：Memory Architecture（`MEMORY_ARCHITECTURE.md`，Sprint 12）、Persistence（Sprint 3）。
- **违规判定**：重启程序后无法复现任务状态即为违规。

## 原则 9：模型换了，任务不能重来

- **要求**：GPT 没额度时：保存 Handoff → Router 重新选模型 → 新模型读取当前 Task → 继续当前 Stage。
- **禁止**：重新开始整个 Workflow；重新拆全部 Sprint；要求用户重新解释需求。
- **落点**：Handoff Protocol（`HANDOFF_PROTOCOL.md`，Sprint 11）、Provider Failover（Sprint 25）。
- **违规判定**：切换模型导致 Task 重做或需用户重复输入即为违规。

## 原则 10：失败是流程的一部分

- **要求**：`Developer → Reviewer → REQUEST_CHANGES → Handoff → Developer Rework → Reviewer → QA`
  是标准路径，默认最多返工 3 次，超过则 `PAUSED` 交 Chief 或用户重新决策。
- **禁止**：失败后直接丢给用户自行处理。
- **落点**：Automatic Rework（Sprint 22）、通用状态机 `REWORK` / `PAUSED`。

## 原则 11：人只参与高价值决策

- **要求**：`LOW` 自动执行；`MEDIUM` 自动执行 + 强制 Review；`HIGH` 执行前审批；`CRITICAL` 必须明确确认。
- **禁止**：让用户参与重复劳动（例如逐条批准普通文件修改）。
- **落点**：Risk System（`SECURITY_MODEL.md`，Sprint 24 Approval）。

## 原则 12：成熟 Workflow 不能每次重新发明

- **要求**：第一次出现新业务由 Chief 设计 Workflow；验证后保存为 Workflow Template；以后同类业务优先
  加载成熟 Template，只允许针对当前项目做有限调整。
- **禁止**：每次让 Chief 从头重新发明流程。
- **落点**：Workflow Library（规划书 §五十）、Template/Fork/Version（Sprint 4）。

## 修订机制

- 本宪法条款的增删改，必须由用户（老板）明确批准，并作为 Decision Record 落盘
  （见 `DECISION_SYSTEM.md`）。
- 任何 Agent（包括 Chief）**无权**自行修改宪法；发现冲突时应提出 Change Proposal 交用户裁决。
- 修改宪法必须同步更新 `AGENTS.md` 与受影响的 `docs/*`，并在 `V1_1_RECONCILIATION.md` 记录差异。

## 与 Industry Pack 的关系

- 宪法对所有 Industry Pack 生效；Pack 只能**细化**行业规则，不能**豁免**宪法。
- Core 必须保持行业无关（规划书 §四），行业词汇属于 Pack：
  `Coding` `Git` `Repository` `Developer` `CTO` `Article` `Video` `Ecommerce`。
- Pack 引入行业能力时，必须同时声明其 Roles / Workflow Templates / Validators / Tools / Artifacts /
  Risk Rules（规划书 §十五），否则视为未完成。
