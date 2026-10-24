> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — 开源 Agent 生态调研与采纳决策

唯一目的：决定哪些外部 agent 系统可以被依赖、以什么形态依赖，以及分发 Electron 时的许可义务。仅覆盖指定的 8 个系统 + 合成决策；不写教程、不做无关扩展。

---

## 0. 证据等级、优先级口径与 Sprint 0 红线（READ FIRST）

**证据通道（决定本文件哪些字段可信）**

| 证据通道 | 本次结果 | 影响 |
|---|---|---|
| `web_search` | **HTTP 401**（search endpoint 认证失败，与 chat endpoint 配置分离） | 无法获取 release / 活动度 / 新闻 |
| `web_fetch` | **ERR_MODULE_NOT_FOUND: `undici`**（`dsh-web-fetch-http` 插件依赖缺失） | 6 次抓取全部失败 → 改用 curl 直连 |
| `api.github.com`（GitHub API） | **HTTP 403**（出口被拒） | `latest release` / `pushed_at` / `stars` 全部不可得 |
| `raw.githubusercontent.com/<repo>/main/LICENSE`（`curl.exe`） | **HTTP 200 × 8/8** | ✅ **Licence 字段全部为已核验事实** |

判定口径：`已验证` = 本次 HTTP 200 取回 LICENSE 全文，经特征串判定（`Apache License Version 2.0` / `Permission is hereby granted, free of charge`）并记录字节长度。`未验证` = 本环境无法观测，**不得用常识填补**；标 `未验证` 的字段须在动工前用 `gh release list` / `gh api repos/{owner}/{repo}` 复核。

**优先级口径（AGENTS.md 优先于本文档其余表述）**：`companyos/AGENTS.md` §2 的阶梯为 **P0**＝Core / Workflow Lifecycle / Versioning / State Machine / Persistence / Handoff / Recovery / Provider Abstraction / Agent-Model 解耦 / Security / Approval；**P1**＝Model Registry / Router / Agent Runtime / Tool Registry / Validation / Risk / Memory / Decision / Artifact / DevCompany Pack；**P2**＝Developer / Reviewer / QA / Git / Rework / Provider Failover / Desktop Workflow UI / Workflow Library UI；**P3**＝Workflow Metrics / 自动绩效 / Worktree / 并行 Agent / 自动优化建议；**P4**＝其他行业 Pack / Cloud / Marketplace / Team。**本文 Phase 列一律按此阶梯填写**；`CANONICAL_SPEC.md` §5 的 P1–P4 编号与之**不一致**（重建文档的已知偏差）→ 见 §13 Q12，必须在 Sprint 1 前 diff 规划书后统一。

⛔ **Sprint 0 红线**：本文档提出的任何 Adapter **均不得在 Sprint 0 落地**（AGENTS.md §3 禁止 Model Router / Agent Runtime / DevCompany / Coding Agent / Workflow Designer / 多模型调度）。`ModelGateway` 与 `AgentRuntimePort` 在 Sprint 0 **只能以类型形式**存在于 `packages/core/src/ports`——无实现、无 provider 名称、无调度逻辑（由 `packages/core/tests/sprint0-guardrails.test.ts` 强制）。**本文件是选型决策记录，不是施工许可。**

**可追溯性缺口**：AGENTS.md §7 要求设计文档可追溯到规划书章节（形如「规划书 §五十九」）。本文件**无法给出该锚点**——`最终1.1.txt` 以 0 字节到达，CANONICAL_SPEC 为重建品。此缺口本身应记入 `PROJECT_HANDOFF.md` 的 Open Risks。

> **结论先行**：8/8 全为 permissive（7× MIT + 1× Apache-2.0），**无 AGPL/GPL/SSPL/BUSL/Elastic**，无一项构成闭源分发的阻断项。真正的风险不在主仓库代码许可，而在 ①LangChain/LangSmith 遥测与传递依赖、②双轨厂商的 relicence 可能、③Python sidecar 与商业控制平面的分发义务。

---

## 1. OpenAI Codex CLI

- **Identity**：https://github.com/openai/codex · maintainer **OpenAI** · 语言 **Rust（`codex-rs` 核心）+ TypeScript（CLI 包装）** · latest release `未验证` · activity `未验证`（GitHub API 403）。
- **Licence**：**Apache License 2.0 / `Apache-2.0` / permissive**。✅已验证：LICENSE 10,200 bytes，首行 `Apache License Version 2.0, January 2004`。闭源 Electron 可用；义务＝随分发提供 LICENSE、保留声明、**有 NOTICE 则传递**、修改变更需标注（§4b）。**无 copyleft**；含显式**专利授予**（§3），是 8 者中专利条款最友好的一项。
- **Architecture in 5 lines**：
  - 核心抽象：`Agent` 主循环 + `codex-core` 的 provider trait，CLI/TUI 仅壳层。
  - 状态/持久化：**rollout JSONL 会话文件**（`~/.codex/sessions/…`），可 resume / fork transcript。
  - 工具调用：内建 shell + `apply_patch`（结构化补丁 DSL）+ **MCP client（stdio）**；执行前经 `approval_policy` 与 OS 沙箱（seatbelt / landlock）双层闸门。
  - 多智能体：**无中心编排器**；靠 sub-agent / MCP 进程与外部壳层组合。
  - 配置：TOML profiles；模型可换，但语义深度绑定 Responses API 的 item/delta 事件模型。
- **What to borrow**：① **turn/item/delta 事件流协议** → 映射 `RunSnapshot` + 审计事件日志；② `apply_patch` 式确定性 diff 作为**一等工具结果**；③ **approval × sandbox 双层门禁** → Governance BC 的 pre-execution gate 范式（P0 设计输入）；④ session `resume/fork` 与 CANONICAL_SPEC §2 的 `fork` 语义同构，可用于交叉校验 fork lineage。
- **Verdict**：`仅借鉴思想`。Rust/TS 双栈不是我们的运行时（Node ≥22 ESM，无原生编译步骤）；模型路径绑定 Responses API；子进程内嵌会引入版本漂移 + stdout 协议脆弱面 + NOTICE 传播义务。
- **框架锁定风险**：**Low**（零代码引入）。⚠️ 若未来封装为 subprocess 工具（**P2** Developer Pack），升为 **Medium**（进程协议 + 版本漂移 + NOTICE 传递）。
- **附注（前次调研记录，本会话未复核）**：上游仓库存在 `NOTICE` 文件（内含第三方 MIT 组件声明）→ §13 Q2 的输入，动工前需复核存在性与内容。

---

## 2. OpenHands

- **Identity**：https://github.com/All-Hands-AI/OpenHands（**已重定向至 `OpenHands/OpenHands`**）· maintainer **All Hands AI / OpenHands contributors** · 语言 **Python（服务端 Agent）+ TypeScript/React（前端）** · latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT` / permissive**。✅已验证：LICENSE 1,082 bytes，`The MIT License (MIT) Copyright © 2025 OpenHands contributors`（沿旧路径抓取成功，与重定向后仓库一致）。闭源 Electron 可用，仅需署名 + 许可文本。**无 copyleft**；CLA 情况 `未验证`。
- **Architecture in 5 lines**：
  - 核心抽象：`Agent`（CodeAct 风格）+ **`Runtime`（可换沙箱：本地 / Docker / 远端）+ `Conversation`** 三者解耦。
  - 状态/持久化：**append-only EventStream**（可回放），session 落文件/DB；前端仅通过 REST/WS 订阅同一事件流。
  - 工具调用：**Action / Observation 显式对称协议**——bash、编辑器、IPython 全由 Runtime 暴露为 action。
  - 多智能体：delegate 子 agent + **microagents**（仓库内 markdown 规则按需注入）。
  - 关键设计：Agent 完全不感知 sandbox 实现细节 → 依赖注入式运行时。
- **What to borrow**：① **`Action/Observation` 对称 + append-only EventStream** = run 事件日志与 checkpoint/resume 的最佳参照物；② **`Runtime` 抽象**反向验证了 `AgentRuntimePort` 该长什么样（实现可换、调用方无感知）；③ **microagent（版本化 markdown 规则注入）** → Industry Pack 绑定 prompt/policy 的形态；④ 前端只订阅、不内联逻辑 → 与 Electron main/renderer IPC 边界同构。
- **Verdict**：`仅借鉴思想`。形态冲突：全功能多用户 Web 应用（Python 服务端 + Docker），与"本地优先、单进程 Electron"相反；`openhands-sdk` 为 Python，Node 侧不可复用。
- **框架锁定风险**：**Low**（零代码引入）。若 P1/P2 复用其沙箱能力，只能以容器/子进程旁路，Core 不得感知。

---

## 3. OpenAI Agents SDK (`openai-agents-python`)

- **Identity**：https://github.com/openai/openai-agents-python · maintainer **OpenAI** · 语言 **Python（官方 TS 移植 `@openai/agents`）** · latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT` / permissive**。✅已验证：LICENSE 1,058 bytes，`MIT License Copyright (c) 2025 OpenAI`。闭源商用无阻碍；无 copyleft、无 network-copyleft。对 OpenAI 贡献代码是否触发贡献者条款 `未验证`（§13 Q5）。
- **Architecture in 5 lines**：
  - 核心抽象：**`Agent`（instructions + tools + handoffs）+ `Runner`（`run` / `run_streamed`）**——契约面极小，无图 DSL。
  - 状态/持久化：**`Session`** 抽象（SQLite / 自定义 memory），轻量，**无 checkpointer 语义**。
  - 工具调用：函数工具（schema 校验）+ hosted tools + **MCP**。
  - 多智能体：**handoff 为一等原语**（agent 间转移即一次工具调用），另有 `guardrails` 与 `tracing` 钩子。
  - 模型层：`Model` / `ModelProvider` 可替换（支持非 OpenAI 后端）→ 与 `ModelGateway` 天然同层。
- **What to borrow / Adapter 落点**：本清单中**契约最小、最贴 `AgentRuntimePort`** 的实现。四件套可 1:1 映射：`Agent`→runtime 配置、`Runner`→runtime loop、**`Guardrail`→Governance policy hook**、**`Handoff`→Execution 的 handoff 记录**。TS 版可作为 **P1 首个 runtime adapter（Sprint 0 不得落地）**，成本低、爆炸半径可控。
- **Verdict**：`Adapter`。落在 `packages/adapters/runtime-openai-agents`，仅该包可 `import`；Core 只见端口 DTO。
- **框架锁定风险**：**Medium**。耦合来源：①**默认 tracing 上报 OpenAI 平台**，与 local-first/隐私承诺直接冲突 → 必须显式关闭或替换 exporter 并加测试断言；②TS 移植滞后 Python，API 仍在快速迭代；③`handoff` / trace 事件模型与 `RunSnapshot` 需规范化转换，**反向泄漏会污染 Core**（靠 §10 门禁拦截）。

---

## 4. LangGraph

- **Identity**：https://github.com/langchain-ai/langgraph · maintainer **LangChain, Inc.** · 语言 **Python + JS（`@langchain/langgraph`）** · latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT` / permissive**。✅已验证：LICENSE 1,067 bytes，`MIT License Copyright (c) 2024 LangChain, Inc.`。⚠️**红旗（供应链级）**：本体 MIT ≠ 依赖树 MIT——`@langchain/core`、`langsmith` 为 MIT，但 **`langchain-community` 等集成包内含第三方条款（部分 GPL/自定义）**（`未验证`，须逐包扫描）；且默认**向 LangSmith 发送 trace**。闭源分发前必须执行 §12 的传递依赖扫描。
- **Architecture in 5 lines**：
  - 核心抽象：**`StateGraph`**（node = 函数，edge = 控制流）+ `State`（reducer 定义合并语义）。
  - 状态/持久化：**checkpointer**（`SqliteSaver` / `PostgresSaver`）按 `thread_id` + `checkpoint_id` 存时间线，支持 replay / time-travel——工业级 checkpoint/resume 答案。
  - 工具调用：`ToolNode` + `@tool`；`Command` 做节点内动态路由。
  - 多智能体：预置 supervisor / swarm 拓扑（`create_react_agent`、handoff tools）。
  - 人机协同：**`interrupt()` / resume** 原生支持 → 与审批 / `TemplateLock` 竞态天然对齐。
- **What to borrow**：checkpointer 的 `(thread_id, checkpoint_id)` 双键模型、reducer 化的 state 合并、`interrupt/resume` 语义。这三者可**只借语义自研**（进 Core），也可**整个借实现**（进 adapter）。
- **Verdict**：`Adapter`（严格限定范围）。仅作为 `WorkflowEngine` 的**候选实现之一**：`packages/adapter-workflow-langgraph`，用于 **P1** run engine 快速验证。**Core 的确定性生命周期 / 版本 / 锁 / fork 语义永不下放给 LangGraph**——那是 CANONICAL_SPEC §2 的法定真相源。
- **框架锁定风险**：**High**。①图与 state schema 一旦写成 LangGraph 形态，迁移成本 ≈ 重写 SOP；②JS 版与 `@langchain/core` 版本强耦合，1.x 迁移期 breaking 频繁；③默认 LangSmith trace（需 `LANGCHAIN_TRACING_V2=false` + 自建 exporter，并被测试断言）。**结论：adapter 边界内允许，Core 内禁止。**

---

## 5. Microsoft Agent Framework

- **Identity**：https://github.com/microsoft/agent-framework · maintainer **Microsoft** · 语言 **C#/.NET + Python**（AutoGen + Semantic Kernel 合并线）· latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT` / permissive**。✅已验证：LICENSE 1,068 bytes，`MIT License Copyright (c) Microsoft Corporation.`。无 copyleft、无 BUSL/SSPL。⚠️MIT **不含专利条款** → 若抄代码而非抄思路，专利面 `未验证`（§13 Q9）。
- **Architecture in 5 lines**：
  - 核心抽象：`AIAgent`（统一 AutoGen/SK 两线）+ **`Workflow`（有向图 + checkpoint）** 双层。
  - 状态/持久化：workflow checkpointing（.NET/Python 侧）+ thread/session 抽象。
  - 工具调用：函数工具、插件（SK plugins）、**MCP**。
  - 多智能体：sequential / concurrent / magentic 编排模式与 workflow 组合。
  - 企业侧：Azure AI Foundry 深度绑定；durable 能力外置到独立扩展仓库。
- **What to borrow**：① `Workflow` 的 checkpoint + **human-in-the-loop 请求模型**（对审批语义的第二种工业参照）；② **role → agent 的显式映射**与 RoleArchetype 的对齐方式；③ MCP 归一化 + 多 provider 插件注册表；④ **"durable 能力不在内核里"** 这一架构判断本身就是对我们 Core 边界的佐证。
- **Verdict**：`仅借鉴思想`。**无 Node/TypeScript 运行时**，重心在 .NET/Azure；引入需 Python/.NET sidecar，破坏 P0 锁定的"无原生编译 + 单进程 Electron"约束（CANONICAL_SPEC §7）。列入 watch-list：若出现 TS 主线需重评。
- **框架锁定风险**：**Low**（零代码引入）。

---

## 6. SWE-agent

- **Identity**：https://github.com/SWE-agent/SWE-agent · maintainer **Princeton/Stanford 研究组（John Yang, Carlos E. Jimenez, …）** · 语言 **Python** · latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT` / permissive**。✅已验证：LICENSE 1,142 bytes，`MIT License Copyright (c) 2024 John Yang, Carlos E. Jimenez, Alexander Wettig, Shunyu Yao, Karthik Narasimhan, Ofir Press`。无 copyleft。⚠️论文与 SWE-bench 数据集资产可能另有条款（`未验证`），勿默认整仓同许可。
- **Architecture in 5 lines**：
  - 核心抽象：**ACI（Agent-Computer Interface）**；`Agent` 与 `Environment` 严格分离。
  - 状态/持久化：**trajectory 文件**，每步 action/observation 落盘，可完整 replay。
  - 工具调用：极简工具集（bash / view / create / edit）+ **编辑失败即报错回灌的 lint 反馈**。
  - 多智能体：基本单 agent（多 agent / SWE-ReX 属研究扩展）。
  - 环境：容器化 eval harness（SWE-bench 式可复现基准）。
- **What to borrow**：① **ACI 哲学：工具返回即反馈**，失败必须携带可自纠信号 → 对应 Execution 的 node 重试 / 失败语义；② trajectory 落盘格式 → run 审计与回放；③ **eval harness / 可复现基准方法论** → `WorkflowMetrics` 怎么定义才不算自欺；④ 其 README 自述"开发重心已转向 mini-swe-agent"是升级路径锁定的教科书案例。
- **Verdict**：`仅借鉴思想`。它是 benchmark 工具而非运行时库；Python + 容器依赖，不适合 Electron 侧 runtime；价值在评测方法论而非代码。
- **框架锁定风险**：**Low**。

---

## 7. MetaGPT

- **Identity**：https://github.com/geekan/MetaGPT · maintainer **geekan / Chenglin Wu（FoundationAgents）** · 语言 **Python** · latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT` / permissive**。✅已验证：LICENSE 1,067 bytes，`The MIT License Copyright (c) 2024 Chenglin Wu`。⚠️代码本体 MIT，但**产品线（如 MGX）与示例/数据资产可能有独立商业条款**（`未验证`）——只可复制思想，不得默认整仓资产同许可。
- **Architecture in 5 lines**：
  - 核心抽象：`Role` + `Action` + `Environment`；SOP 由 **Action 序列 + Message 订阅关系硬编码**表达。
  - 状态/持久化：内存 `Environment` + 可选序列化快照，**无常驻事务性 DB 语义**。
  - 工具调用：以 `Action` 类包装（`WriteCode` / `RunCode` / `Search`），非标准化 tool schema。
  - 多智能体：角色 **publish-subscribe 并发**（PM → Architect → Engineer → QA），不是图。
  - 输出中心：以 PRD / 设计 / 代码等**交付物**为核心产物（产物即验收材料）。
- **What to borrow**：① `Code = SOP(Team)` 的理念可直接引用为价值主张外部佐证；② **role archetype → 交付物模板** 的映射（与 Org BC 的 RoleArchetype + RACI 同构，可用于检验 archetype 字段完备性）；③ "SOP = 有序 Action + 交接物"的叙事 → Workflow Designer 的用户心智模型。
- **Verdict**：`仅借鉴思想`。其 SOP 是**提示级隐式顺序**，没有 version / contentHash / fork / lock 语义；直接依赖会把"隐式提示顺序"当成流程真相，与 CANONICAL_SPEC §2 生命周期法冲突（且违反架构法：Core 不得被框架名词占领）。
- **框架锁定风险**：**Low**。

---

## 8. CrewAI

- **Identity**：https://github.com/crewAIInc/crewAI · maintainer **CrewAI, Inc.** · 语言 **Python** · latest release `未验证` · activity `未验证`。
- **Licence**：**MIT / `MIT`（OSS 本体）**，与**商业 Enterprise 版双轨并行** / permissive-with-commercial-track。✅已验证：LICENSE 1,052 bytes，MIT 授予条款，`Copyright (c) 2025 crewAI, Inc.`。⚠️**红旗（轻度）**：单一厂商双轨 → **relicence 与功能向企业版倾斜的厂商风险**；当前 OSS 本体商用无碍。CLI/依赖是否含附加条款 `未验证`。
- **Architecture in 5 lines**：
  - 核心抽象：`Crew`（agents[] + tasks[] + process: sequential | hierarchical）+ `Flow`（`@start` / `@listen` / `@router` + 结构化 state）。
  - 状态/持久化：弱——`Memory` 走向量/RAG 式存储；checkpointing 为渐进能力，无不可变运行快照。
  - 工具调用：`BaseTool` / langchain 工具生态 → **把 langchain 依赖树拖进依赖图**。
  - 多智能体：hierarchical 模式下由 **Manager agent** 做委派与校验（管理权在 prompt 里）。
  - 输出：`Task.output` 结构化字段；**OSS 默认开启匿名遥测**（`OTEL_SDK_DISABLED` 可关）。
- **What to borrow**：① `Task → output` 的 schema 约束方式；② Flows 的"事件驱动 + 显式 state"组合印证了确定性与可读性可兼得；③ hierarchical manager 的**反面教材**：管理权若由 prompt 里的 manager agent 决定，等于把 Org BC 的 authority/RACI 降级为提示词——派发权必须由 Org 实体裁决。
- **Verdict**：`不建议采用`。①Python-only，无 Node 运行时；②`Role`/`Crew`/`Task` 与 Org BC + Workflow BC **语义重叠** → 制造两个真相源，直接违反架构法；③依赖树引入 langchain；④双轨许可 + 厂商锁定；⑤默认遥测与 local-first 隐私承诺冲突。
- **框架锁定风险**：**High**（若采用）——业务语义被外部 `Crew`/`Task` 类型绑架，迁出即重写。

---

## 9. 决策矩阵（Decision Matrix）

> Phase 列按 **AGENTS.md §2** 阶梯填写（见 §0 优先级口径）。

| Project | Licence | Verdict | Lock-in risk | Phase (P0–P4) | Rationale |
|---|---|---|---|---|---|
| OpenAI Codex CLI | `Apache-2.0` ✅ | `仅借鉴思想` | Low | **P2**（+P0 借 approval×sandbox 设计） | 事件流 JSONL / apply_patch / 审批×沙箱双层可抄；Rust-TS 双栈不可依 |
| OpenHands | `MIT` ✅ | `仅借鉴思想` | Low | **P1/P2**（DevCompany Pack 内） | Action/Observation 对称 + EventStream + Runtime 抽象是端口设计参照；Python Web 应用不可依 |
| OpenAI Agents SDK | `MIT` ✅ | **`Adapter`** | Medium | **P1** | 契约面最小、最贴 `AgentRuntimePort`；须关 tracing；TS 版滞后 Python |
| LangGraph | `MIT` ✅ | **`Adapter`** | High | **P1** | checkpointer / interrupt 是 run engine 最短路径；仅在 `WorkflowEngine` adapter 内，Core 禁入 |
| Microsoft Agent Framework | `MIT` ✅ | `仅借鉴思想` | Low | **P4（watch-list）** | 无 Node 运行时；workflow checkpoint + HITL 模型可借；出 TS 主线再评 |
| SWE-agent | `MIT` ✅ | `仅借鉴思想` | Low | **P2** | ACI 反馈哲学 + trajectory + eval harness 方法论；非运行时库 |
| MetaGPT | `MIT` ✅ | `仅借鉴思想` | Low | **P2/P3** | 角色→交付物映射可借；提示级 SOP 无版本语义，须由 `WorkflowVersion` 承载 |
| CrewAI | `MIT`(+企业双轨) ✅ | **`不建议采用`** | High | **—** | 语义重叠制造第二真相源；Python-only；拖 langchain；厂商双轨 |

**为什么没有任何一项是 `直接依赖`**：架构法（AGENTS.md §1.3 + CANONICAL_SPEC §1/§4）要求 `@companyos/core` **零运行时依赖**、端口先行；上述系统**无一为 TS-first / 本地优先 / 可嵌入单进程 Electron 的库**。故最优解恒为 `Adapter`（外环）或 `仅借鉴思想`（设计）。
**共同缺口**：8 个项目**没有一个**同时提供「工作流模板版本化 + 不可变运行快照 + 确定性状态机 + 审批门 + 断点恢复」——这五项恰是本产品的壁垒，**只能自建**。

---

## 10. 依赖策略（Dependency Policy — 硬规则，由门禁强制）

### 10.1 铁律
> **`@companyos/core` 的第三方 agent-framework 依赖数恒为 0；运行时依赖数同样为 0。**

禁止出现在 Core 的 `package.json` 与任何 import 说明符中（含传递）：`@openai/*`、`openai-agents*`、`langchain*`、`@langchain/*`、`langsmith`、`openhands*`、`metagpt`、`crewai`、`microsoft.agents`、`autogen*`、`semantic-kernel`。

### 10.2 分层与允许依赖

| 层 | 包 | 允许依赖 | 禁止 |
|---|---|---|---|
| **L0 Kernel/Core/契约** | `@companyos/core`、`@companyos/contracts` | **零运行时依赖**（AGENTS.md §1.3）：仅 TypeScript 源码 + Node 标准库类型；端口（`Clock`/`IdFactory`/`Logger`/`EventBus`/`EntityStore`/`MigrationRunner`/`SecretResolver`/`ModelGateway`/`AgentRuntimePort`）**仅接口与 DTO**；ULID 经 `IdFactory` 注入，Core 内不引入 ulid 包 | 任何 agent 框架、任何第三方运行时依赖、任何 I/O 实现、任何 Electron/React |
| **L1 端口实现** | `@companyos/persistence`、`@companyos/observability`、未来的 `@companyos/model-router` | `node:sqlite`、Node 内置 | agent 框架 |
| **L2 外环 adapter（唯一可 import 框架的环）** | `adapters/runtime-openai-agents`（P1）、`adapters/workflow-langgraph`（P1）、未来的 `adapters/model-*` | 各 adapter **恰好一个**框架，**精确版本钉死（无 `^`）** | 跨 adapter 互相 import；向 Core 暴露框架类型 |
| **L3 Apps / Packs** | `apps/desktop`、`packs/*` | `@companyos/core` + 由组合根显式注入的 adapter；Packs 依赖 Core，**Core 永不依赖 Pack** | renderer 直接 import adapter；Pack 越过 Core 直连框架 |
| **L4 越界** | — | **禁止**：`packs/*` → 第三方 agent 框架；renderer → 任何 L2 | — |

### 10.3 端口如何隔离（`ModelGateway` / `AgentRuntimePort` / `WorkflowEngine`）

> **命名对齐**：AGENTS.md §3 用 **`AgentRuntimePort`**（Sprint 0 只允许以类型存在于 `packages/core/src/ports`）；CANONICAL_SPEC §4 写作 **`AgentRuntime`**。二者指同一端口，**命名以 AGENTS.md 为准**，此差异需在 diff 规划书时一并统一。
> ⚠️ **[DERIVED] 缺口**：CANONICAL_SPEC §4 端口清单**未包含 `WorkflowEngine`**。本文档按任务需要引用它；动工前必须 diff 规划书后正式补入端口清单，否则"端口先行"不完整（§13 Q11）。

1. **纯接口 + 纯 DTO**：端口签名只出现 Core 自有类型（`Result<T, PortError>`、`RunId`、`ModelBinding`）。**任何 Core 签名里不得出现 `Agent` / `StateGraph` / `Crew` / `Task`**——转换一律在 adapter 内完成（防腐层 / Anti-Corruption Layer）。
2. **失败降级**：adapter 不可用必须返回 `Result.Err(PORT_UNAVAILABLE)`，Core 不得因 adapter 崩溃而崩；adapter 以**动态 import** 装载，缺失即降级（本地优先产品必须能"无 adapter 启动"）。
3. **组合根唯一**：仅 `apps/desktop/src/main/composition.ts` 可 import 具体 adapter；renderer 通过 typed preload bridge 走 IPC，**永不** import adapter。
4. **三层各自的门**：`ModelGateway`（模型调用 / 计费 / token）→ `adapters/model-*`；`AgentRuntimePort`（执行循环 / 工具 / 交接）→ `adapters/runtime-*`；`WorkflowEngine`（图执行 / checkpoint / resume）→ `adapters/workflow-*`。**一个 adapter 只实现一个端口，不跨层。**
5. **版本契约**：每个 adapter 在包内声明 `adapterContractVersion`，启动时与 Core 端口版本比对，不匹配即拒绝装载（防静默行为漂移）。
6. **门禁落点（AGENTS.md §1.4；`pnpm check` = lint → typecheck → boundaries → test → build，必须 Exit Code 0）**——必须同时覆盖清单级与类型级，缺一漏：
   - (a) `node scripts/check-boundaries.mjs` 扩展为**解析 `packages/core/package.json` 的 `dependencies` 必须为空**（import 级检查抓不到"只声明未使用"的依赖，而 AGENTS.md §1.3 要求 Core 零运行时依赖）；
   - (b) 禁止名（§10.1 清单 + AGENTS.md §1.1 行业词汇表）须同时覆盖 **import 说明符**、**ESLint `no-restricted-syntax` 的标识符/类型名/文件名**与 **`package.json`** 三处；
   - (c) `packages/core/tests/sprint0-guardrails.test.ts` 增补：对 Core 跑 `tsc --emitDeclarationOnly` 后扫描 `.d.ts` 产物**不得出现框架类型名**（`Agent` / `StateGraph` / `Crew` / `Task` 等）——防类型穿透，比源码扫描更严格；
   - 词汇替换按 AGENTS.md §1.1 执行（Coding→Work/Task/Assignment、Git→Versioned artifact store、Repository→**`EntityStore`**、Developer→WorkRole/Contributor、CTO→RoleArchetype、Article→WorkProduct、Video→MediaAsset、Ecommerce→DomainPack capability）；并保留既有规则：`packages/core/src/**` 内不得出现 `repository` 标识符。
7. **门禁自检**：`pnpm test:scripts`（`node --test`）必须覆盖上述新增断言；任一断言失败即非 0 退出。
8. **ESLint**：`no-restricted-imports` + `no-restricted-syntax` 在 `@companyos/core` 配置上述包前缀通配（含 `@langchain/*`）。

---

## 11. 拒绝 / 观察清单（Rejected / Watch-list）

| 项目 | 分类 | 理由 / 复审触发条件 |
|---|---|---|
| CrewAI | **拒绝** | §8：语义重叠制造第二真相源 + Python-only + 拖 langchain + 双轨许可 + 默认遥测 |
| LangChain（作为编排层） | **拒绝** | 抽象面过大且不稳定；仅允许被 adapter 间接带入，且必须声明在 adapter 自己的 `package.json` 内 |
| Dify / Flowise | **拒绝** | 产品形态冲突（Web 平台，非可嵌入库）；**licence 未验证**（存在 AGPL 传闻，引入前必须核验） |
| n8n | **拒绝** | 非 OSI 许可（Sustainable Use License / fair-code，**未验证**）；形态冲突 |
| Mastra (TS) | **观察** | TS 原生、贴 Electron/Node 形态，可能是比 LangGraph 更优的 TS runtime；**licence 未验证** → 引入前必须核验（P1 选型对比项） |
| Vercel AI SDK | **观察** | TS 生态，可能更适合作为 `ModelGateway` 实现基础；**licence 未验证** |
| AutoGen（单独） | **观察** | 已并入 Microsoft Agent Framework；Python-only |
| Pydantic AI / DSPy | **观察** | 概念优秀但 Python；仅作 prompt / schema 设计参考 |
| Temporal / Inngest | **观察** | 确定性工作流引擎（非 agent 框架），P1 checkpoint/resume 备选；Temporal **licence 未验证**；Inngest 云端形态冲突 |
| OpenAI Codex（作为 subprocess 工具） | **观察** | P2 Developer Pack 选项之一；复审条件：进程协议稳定 + NOTICE 传递方案就绪 + 商标表述合规 |
| mini-swe-agent | **观察** | SWE-agent 的继任项目（**licence 未验证**）；仅作评测方法论参考 |

---

## 12. Licence 合规清单（Electron 闭源分发）

- [ ] **生成 NOTICE 产物**：`pnpm licenses list --prod --json > build/third-party-licenses.json`，渲染为 `THIRD_PARTY_NOTICES.md`，**打进 asar** 并在 Electron **About 对话框**可离线查看（本清单 8 项全为 MIT/Apache → 属"仅需署名"类义务）。
- [ ] **CI 拒绝条款门**：读取 `pnpm licenses list --prod --json`，命中 `dependencies` 中 SPDX ∈ `{GPL-2.0*, GPL-3.0*, AGPL-3.0*, SSPL-1.0, BUSL-1.1, Elastic-2.0, CPAL-*, OSL-*, CC-BY-NC-*, Sustainable Use}` 即 **fail**。`LGPL-*` 单列人工评审（§13 Q9）。
- [ ] **传递依赖扫描**：`license-checker-rseidelsohn --production --onlyAllow "MIT;Apache-2.0;ISC;BSD-2-Clause;BSD-3-Clause;0BSD;CC0-1.0;Unlicense"`（**重点盯 langchain 生态**：`langchain-community` 等集成包可能携带第三方条款）。
- [ ] **Apache-2.0 义务**（若复制 codex 的 `apply_patch` 规范 / 提示词 / 代码）：保留 LICENSE、**传递上游 NOTICE（§4d）**、修改文件加变更说明。→ 先确认上游 NOTICE 存在性与内容（§13 Q2）。
- [ ] **SBOM**：每次 release 生成 `npx @cyclonedx/cyclonedx-npm --output-file build/sbom.json`，与安装包一同归档。
- [ ] **lockfile 钉死**：`pnpm-lock.yaml` 入库；CI 与打包流水线一律 `pnpm install --frozen-lockfile`（AGENTS.md §4 DoD 已要求）；adapter 依赖用精确版本（无 `^`）；PR 必须审 lockfile diff；完整性以 lockfile 内 integrity 哈希为准（保持 `verify-store-integrity` 开启）。
- [ ] **漏洞审计**：`pnpm audit --prod --audit-level=high` 进 CI；另加 `osv-scanner --lockfile pnpm-lock.yaml`；每周定时任务（0-day 窗口）。
- [ ] **renderer 产物断言**：打包后断言 renderer chunk 内**不得出现框架字符串**（`grep -rE "langgraph|@langchain|@openai/agents" apps/desktop/dist/renderer` 必须为空）——**把框架打进 renderer = 在分发它**，与"仅 main 侧 adapter 可用"的分层一致。
- [ ] **遥测关断（产品承诺级）**：`LANGCHAIN_TRACING_V2=false`、`LANGSMITH_API_KEY` 不设、Agents SDK tracing 显式关闭，并以**测试断言**兜底（local-first / 隐私承诺与遥测互斥）。
- [ ] **模型 / 数据与代码许可分离**：`ModelGateway` 文档声明"用户自带 API key、不随包分发权重"；provider ToS 独立归集，不并入代码 NOTICE。
- [ ] **商标**：产品名与 UI 不得使用 OpenAI / Codex / CrewAI / LangGraph / Microsoft 作背书式表述；仅允许指名性署名（"Built with …"），且不得暗示 endorsement（Apache-2.0 §6 明确不授予商标许可；MIT 亦不含商标）。
- [ ] **Sidecar 条款**：若 P2/P4 以 Python sidecar 复用 OpenHands / SWE-agent 工具，Python 解释器本体（PSF licence）与容器镜像内组件须**单独归集**，不得沿用代码 NOTICE。

---

## 13. Open questions for legal review

1. Electron **About 对话框 + 随包文本文件**的 MIT 署名形式是否充分？是否必须提供可离线访问的完整 licence 全文（而非"链接到官网"）？
2. 从 codex 复制 `apply_patch` 规范 / 提示词 → **Apache-2.0 NOTICE 传递义务的确切范围**；上游若无 NOTICE，是否仅需 LICENSE + 变更说明？（本次未核 NOTICE；前次调研记录称其存在，需复核）
3. 引入 Python sidecar（P2/P4 复用 OpenHands / SWE-agent 工具链）是否改变**"分发"的定性**？PSF 侧是否需要单独的许可归集？
4. `langchain-community` 等集成包携带的第三方条款（部分 GPL / 自定义，**未验证**）——是否采取"**整体禁用该包**，只允许 `@langchain/core`、`@langchain/langgraph`"的硬规则？
5. 向上游（OpenAI / LangChain）回馈 PR 是否触发 CLA / 贡献者条款，对闭源主体的资产界定有何影响？
6. P4 Cloud 若引入服务端并含 AGPL 组件，是否触发 **AGPL §13 网络分发**条款？→ 是否需立"**AGPL 禁入 P4 服务端**"硬规则？
7. 双轨厂商（CrewAI / LangChain）的 relicence 风险：**adapter 可替换性**是否可作为法务认可的缓解措施（即把 High lock-in 降级为可接受）？
8. 商标检索："CompanyOS" 命名冲突；UI 中第三方名称的指名性使用边界（Apache-2.0 §6 / MIT 均不授予商标权）。
9. **LGPL 判定**：Electron 单 asar 打包场景下，LGPL 依赖是否构成"静态链接"从而触发替换 / 重链接义务？另：MIT 项目未明示专利授权，抄代码（非抄思路）的专利面如何界定？
10. **`未验证` 项的法务前置**：release 日期、Mastra / Vercel AI SDK / Dify / n8n / Temporal / mini-swe-agent 的许可、上游 NOTICE 存在性——是否立规"**未验证即不得进入 `dependencies`**"？
11. **[DERIVED] 端口缺口**：`WorkflowEngine` 未列入 CANONICAL_SPEC §4 端口清单；`AgentRuntimePort`（AGENTS.md）与 `AgentRuntime`（CANONICAL_SPEC §4）为同一端口的不同命名。是否正式补入并统一命名？
12. **[DERIVED] 优先级阶梯冲突**：CANONICAL_SPEC §5（P1 Kernel / P2 Model Router + Agent Runtime / P3 Industry Packs / P4 Ecosystem）与 AGENTS.md §2（P0 Core 全量 … P4 Cloud/Marketplace）**编号不一致**。本文 Phase 列取 AGENTS.md；Sprint 1 前必须 diff 规划书统一，否则 P1/P2 的施工范围会与 DoD 冲突。
13. 8 个项目的**商业控制平面**（LangSmith / Deployment、OpenHands Cloud & Enterprise、CrewAI AMP、Codex Web、MGX、Foundry Hosted Agents）均不在主仓库 MIT/Apache 覆盖范围内，条款全部 `未验证`——本地优先路线是否需在文档中显式声明"不使用任何托管控制平面"以免误触？

---

## 14. Sources

**已实际使用并验证（HTTP 200，本次会话抓取，`main` 分支 HEAD；未钉 SHA → 上游可能变更，发布前需复核）**

- OpenAI Codex CLI LICENSE — https://raw.githubusercontent.com/openai/codex/main/LICENSE
- OpenHands LICENSE — https://raw.githubusercontent.com/All-Hands-AI/OpenHands/main/LICENSE
- OpenAI Agents SDK LICENSE — https://raw.githubusercontent.com/openai/openai-agents-python/main/LICENSE
- LangGraph LICENSE — https://raw.githubusercontent.com/langchain-ai/langgraph/main/LICENSE
- Microsoft Agent Framework LICENSE — https://raw.githubusercontent.com/microsoft/agent-framework/main/LICENSE
- SWE-agent LICENSE — https://raw.githubusercontent.com/SWE-agent/SWE-agent/main/LICENSE
- MetaGPT LICENSE — https://raw.githubusercontent.com/geekan/MetaGPT/main/LICENSE
- CrewAI LICENSE — https://raw.githubusercontent.com/crewAIInc/crewAI/main/LICENSE

**仓库主页（Identity 来源）**

- https://github.com/openai/codex · https://github.com/All-Hands-AI/OpenHands · https://github.com/openai/openai-agents-python · https://github.com/langchain-ai/langgraph · https://github.com/microsoft/agent-framework · https://github.com/SWE-agent/SWE-agent · https://github.com/geekan/MetaGPT · https://github.com/crewAIInc/crewAI

**失败通道（记录以便复现，非来源）**

- `web_search` → HTTP 401 Authentication Fails（search endpoint `https://api.deepseek.com/anthropic/v1/messages`，与 chat 配置分离）
- `web_fetch` → `ERR_MODULE_NOT_FOUND: Cannot find package 'undici'`（`dsh-web-fetch-http/lib/index.js`）
- `https://api.github.com/repos/{owner}/{repo}`（及 `/license`、`/releases/latest`）→ **HTTP 403**（出口被拒）→ 故所有 `latest release` / `activity` 字段标记 `未验证`

**内部来源**

- `companyos/AGENTS.md`（§1.1 词汇法 / §1.2 `EntityStore` / §1.3 方向法与零运行时依赖 / §1.4 门禁 / §2 优先级阶梯 / §3 Sprint 0 禁止项 / §4 DoD / §7 文档可追溯）
- `.planning/CANONICAL_SPEC.md`（§0 重建声明、§1 架构法、§2 生命周期与 `RunSnapshot`/`TemplateLock`/`WorkflowVersion`、§4 端口清单、§5 优先级、§7 技术锁定）
