# EXECUTION CAPABILITY MODEL — frozen (V1 Execution Architecture Freeze §15-§22)

Capability 回答 **“需要什么能力？”**，不回答 **“该哪家厂商跑？”**。

## 1. 既有能力概念与规范属主（盘点，无新建系统）

| 能力概念 | 规范载体 | 属主 |
|---|---|---|
| work kind（任务种类） | `tasks.kind` / `taskProfile.taskKind`（钉定版本 config） | Pack/钉定版本 |
| executor kind（可执行种类声明） | `stageHandlers.executorKinds`（组合部署数据） | 部署组合 |
| model capability | `ModelCapabilities`（core 端口：streaming/structuredOutput/toolCalling/vision/audio/reasoning） | 模型注册表 |
| repository capability | `repositoryRuntime.repositoryCapableKinds` + 工作区 lease/path policy | 组合（T17-08 缝） |
| provider capability | `ExecutorCapabilityName` 闭集（S24：cancellation/timeout/structured-output/working-directory/stdin/external-session-identity/session-continuation/streaming-diagnostics + 诚实不广告集） | ExecutorProvider 契约 |
| Pack capability | Pack manifest 九类声明（S15） | Pack 框架 |
| tool capability | `ToolRecord` + 风险分级 + 幂等（S9） | 工具注册表 |
| authority/policy 约束 | authz（Role→Authority）、Decision/Approval、selection policies | 既有权威体系 |

**术语复用裁定**：上述即全部能力词汇；禁止再造平行 capability registry / capability token。

**真实缺口（记录）**：能力路由（由任务语义推导 Required Capability Set）V1 为静态部署路由，未实现自动推导——见 §3 演进。

## 2. 两段式路由（§16）

**A. CAPABILITY ROUTING** —— “此 Task 需要哪些能力？” 输入：任务语义/角色/风险/工作区/副作用/输出契约。输出：**Required Capability Set**。V1 形态：钉定版本 taskProfile + 部署 providerKinds/providerRoutes（静态、确定性）。

**B. PROVIDER / EXECUTION ROUTING** —— “在当前合格且可用的能力提供者中选谁？” 输入：所需能力、可用性、用户/部署策略、历史可靠性、成本、时延、质量、风险、项目连续性。V1 形态：显式路由表 + 公司 MANUAL 模型选择。

**禁止**：把两层合并成一个巨型 AI 路由器。

## 3. 成本感知路由原则（§17，冻结）

**MOST APPROPRIATE，不是 MOST POWERFUL。**
正常选择序：① 硬能力过滤 → ② 策略/权威过滤 → ③ 可用性过滤 → ④ 可靠性/历史 → ⑤ 成本/时延/质量权衡 → ⑥ 仅当仍有歧义时低成本推理裁决。
**禁止**：跑遍所有 provider 比输出投票（太贵，非 V1 政策）。

## 4. Model Pool（§18，概念冻结）

Model profile 可暴露：推理能力、上下文窗口、结构化输出支持、模态、时延、成本、可靠性、可用性；Planner/Supervisor 请求的能力。canonical 业务语义零厂牌名。**本任务不建模型市场。**

## 5. Executor Pool（§19，概念冻结）

Executor capability profile 可暴露：执行类别（见 §6）、工作区支持、文件/进程/git/浏览器/API、结构化结果、取消、续作、provider Session 语义、成本、时延、历史可靠性。外部 provider 内部机制留在适配器内。

## 6. 执行类别（§20，仅在不重复既有词汇处定义）

- **NATIVE**：CompanyOS 掌控的确定性能力（进程/文件/Git/HTTP/数据/未来浏览器）——见 NATIVE_EXECUTION_RUNTIME.md。**首个能力已实现**：`native.process`（`apps/desktop/src/executor/native-process-provider.ts`，V1 Native Execution Foundation 分类 B）——受信部署操作表（taskKind→{executable, 字面 argv, 界限}）驱动、复用 ExecutorProvider/S25 预检/结算全链、ARCH-039 守护"自然语言任务内容永不成为可执行体"。
- **AGENTIC**：开放式自主多步执行（未来可选适配器：Codex/ZCode/DSH/其他 agent runtime；DSH 现状=OPTIONAL_PROVIDER_UNAVAILABLE_AUTH）。
- **SERVICE**：外部确定性/专业服务能力（搜索/数据库/邮件/CRM/云与业务 API）。

**ModelProvider 保持纯推理能力，不因拥有适配器就自动成为 Executor。**

## 7. 反膨胀法（§21，冻结）

新增一个外部执行器，正常只应新增：**适配器 + 配置 + 能力描述符 + 适配器自有测试**。
不应需要新的：Task 模型 / Workflow / Run truth / Artifact truth / Session truth / Authority / Validation 体系。
禁止 Core 业务分支 `if provider == codex/dsh/zcode`——厂牌逻辑只在外环（ARCH-037 已机械守护）。

## 8. Router V1 范围（§22）

**现在建**：确定性能力匹配 + 可用性 + 显式部署/用户策略 + 简单成本/质量优先级。
**不建**：学习型路由、多 provider 锦标赛、历史训练 governor、大型评分引擎。
演进路线（仅记录）：V1 规则+能力匹配 → V1.x 历史成功/成本/时延 → 后续 小型路由/governor 模型 → 更远 基于真实 CompanyOS 结果数据的自适应策略。
