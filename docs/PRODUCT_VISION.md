# CompanyOS 产品愿景

> 依据：规划书 §一（一句话定义）、§二（十二条原则）、§六十五（最终体验）、§七十（最终愿景）。
> 本文件回答「我们要做成什么」；「怎么建」见 `ARCHITECTURE.md`，「这一阶段做什么」见 `MVP_SCOPE.md`。

## 一句话定义

> **CompanyOS 是一个能够组织多个 AI 模型、Agent 和真实工具，按照行业 SOP 协同完成业务目标的
> AI 工作操作系统。**

它**不是**多模型聊天器，**不是**模型切换器，也**不是**把 GPT、Claude、DeepSeek、Kimi 的 API
接进一个界面。它真正解决的是（规划书 §一）：

谁做什么、什么时候做、谁最适合做、采用哪套 SOP、什么标准算完成、谁负责审核、失败交给谁返工、
哪些事情必须人工批准，以及整个过程中知识、状态、规则、流程和决策如何长期保存与持续进化。

## 十二条原则摘要

| # | 原则 | 一句话含义 |
|---|---|---|
| 1 | 用户是老板 | 用户只说目标；系统自行转成 Workflow→Stage→Task→Role→Model→Tool→Review→Validation→Delivery |
| 2 | 模型只是员工 | 模型可随时替换：升级/降级/涨价/缺额度/宕机都不能让公司停摆 |
| 3 | Agent 是岗位 | 设计 Developer/Reviewer/Writer/Chief 等岗位，而不是「Claude Agent / GPT Agent」 |
| 4 | Workflow 才是生产能力 | 核心资产 = Workflow + SOP + Validation + Memory + Decision + Performance Data |
| 5 | Chief 想、Orchestrator 管、Agent 干 | 职责分层；Chief 不得越过 Orchestrator 直接改状态 |
| 6 | Orchestrator 是制度，不是 AI | 必须是确定性程序；不允许「我觉得下一步可以开始了」 |
| 7 | 真实结果优先于 AI 自述 | 以 Exit Code / Diff / Tool Result / Artifact 为事实，不认「测试已通过」 |
| 8 | 知识不依赖聊天上下文 | 必须落库：Database / Memory / Handoff / Decision / Artifact / Event / Template |
| 9 | 模型换了任务不能重来 | Handoff → 重路由 → 继续当前 Stage；禁止重开 Workflow、重拆 Sprint |
| 10 | 失败是流程的一部分 | 退回、返工、重审是标准路径，而不是把失败丢给用户 |
| 11 | 人只参与高价值决策 | LOW 自动；MEDIUM 自动+强制 Review；HIGH 审批；CRITICAL 明确确认 |
| 12 | 成熟 Workflow 不能每次重新发明 | 验证后的流程沉淀为 Template，同类业务只做有限微调 |

## 最终体验

用户不应该感觉「我正在操作 Claude」或「我正在切 DeepSeek」。
用户应该感觉（规划书 §六十五）：

> **我的公司正在完成任务。**

具体表现为：
- 用户只提交目标，例如「给这个软件增加批量字幕编辑功能」「帮我运营一个公众号 7 天」；
- 系统自行选择或设计 SOP、拆解任务、分配岗位、挑选模型、调用工具、审核、返工、验证、交付；
- 全过程在 Desktop 上可见：Workflow Timeline、Agent Fleet、Events、Artifacts、Handoff、
  Validation、Cost、Workflow Metrics；
- 任何一次执行都可以回答：谁做的、什么时候、用哪个模型、哪套 Workflow Version、调了什么工具、
  改了什么、为什么改、花了多少钱、结果如何（规划书 §四十四）。

## 最终愿景

CompanyOS 的真正价值不是让某一个 AI 更聪明，而是（规划书 §七十）：

> **让一群能力不同、可以随时替换的 AI，在一套持续积累、持续验证、持续优化的组织制度和行业 SOP
> 下，长期稳定地完成真实业务。**

最终闭环：目标进入系统 → 理解 → 选择 SOP（必要时设计新 SOP）→ 拆解 → 分工 → 选模型 → 调工具 →
执行 → 审核 → 返工 → 验证 → 交付 → 记忆 → 复盘 → 优化 Workflow → 形成更成熟的新版本。

结果是：**模型会变、员工会变、供应商会变、API 会失效，但公司的制度、流程、知识、经验、任务状态和
生产能力会不断积累。**

## 非目标

以下内容在 MVP 明确不做（规划书 §五十三），当前阶段更不做：

- 正式 ContentCompany / VideoStudio / EcommerceCompany 等第二行业公司；
- Cloud SaaS、Multi-user、Team Collaboration、Marketplace、Mobile；
- 复杂 RAG、Vector Database、Agent Farm、Kubernetes、超复杂并行 Agent；
- 自动生产部署；
- 「接更多模型」本身：接口数量不是壁垒（规划书 §六十三）。

真正的壁垒是：行业 SOP、Workflow Library、Workflow Lifecycle、Workflow Versioning、任务拆解质量、
模型路由、Agent 分工、跨模型 Handoff、组织 Memory、Decision Memory、Validation、Risk、Approval、
Automatic Rework、Recovery、历史绩效数据、Workflow Performance、Workflow Evolution、Industry Packs。
